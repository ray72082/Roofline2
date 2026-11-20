import {demo} from "./demo.mjs";
const app = document.querySelector("#app");
const isDemo = !globalThis.ROOFLINE_SERVER;
const params = new URLSearchParams(location.search);
const customer = params.has("reception");
const company = params.get("reception") || params.get("company") || (isDemo ? "cedar" : "");
const pages = ["Overview", "Company setup", "Conversations", "Calendar", "Follow-ups", "Billing"];
const esc = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"})[character]);
const href = (key, id) => "?" + new URLSearchParams({[key]: id});
const date = value => new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const panel = content => '<section class="panel">' + content + "</section>";
const field = (label, name, value, type = "text") =>
  '<label>' + label + '<input name="' + name + '" type="' + type + '" value="' + esc(value) + '" required></label>';
const area = (label, name, value) =>
  '<label>' + label + '<textarea name="' + name + '">' + esc(value) + '</textarea></label>';
const rows = (items, empty) => items.length ? items.map(item => '<div class="row">' + item + '</div>').join("") : '<p class="muted">' + empty + '</p>';
const preview = isDemo ? '<p class="notice">Demo workspace. Use sample details. Booking, messaging and billing providers are simulated.</p>' : "";
let profile;
let currentConversation;
let conversationToken = customer ? sessionStorage.getItem("roofline-chat:" + company) : null;
let preferredService;
let preferredStaff;

async function api(action, input, token) {
  const path = [company, action, token].filter(Boolean).map(encodeURIComponent).join("/");
  if (isDemo) return demo(path, input);
  const response = await fetch("/api/" + path, input ? {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(input)
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function bind(id, action) {
  const form = document.getElementById(id);
  if (!form) return;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      const error = document.getElementById("error");
      if (error) error.textContent = "";
      await action(Object.fromEntries(new FormData(form)));
    } catch (error) {
      document.getElementById("error").textContent = error.message;
    } finally {
      if (button) button.disabled = false;
    }
  });
}

function settings(state) {
  return '<form id="settings">' +
    '<div class="fields">' + field("Company name", "name", state.name) + field("Industry", "industry", state.industry) +
    field("Follow-up delay (minutes)", "followupMinutes", state.followupMinutes, "number") + '</div>' +
    area("Receptionist greeting", "greeting", state.greeting) + area("Intake questions (one per line)", "questions", state.questions.join("\n")) +
    area("FAQs (question | answer)", "faq", state.faq.map(item => item.question + " | " + item.answer).join("\n")) +
    area("Services (name | minutes)", "services", state.services.map(item => item.name + " | " + item.minutes).join("\n")) +
    area("Staff (one per line)", "staff", state.staff.join("\n")) +
    '<div class="fields">' + field("Weekday opening hour (UTC)", "startHour", state.startHour, "number") +
    field("Weekday closing hour (UTC)", "endHour", state.endHour, "number") + '</div>' +
    area("Follow-up SMS. Use {company} for the company name.", "followup", state.followup) + '<button>Save settings</button></form>';
}

function workspaceView(page, state) {
  switch (page) {
    case 0: return '<div class="metrics">' + [
      ["Conversations", Object.keys(state.conversations).length], ["Bookings", state.bookings.length],
      ["Scheduled follow-ups", state.jobs.filter(item => item.status === "scheduled").length]
    ].map(([label,count]) => panel(esc(label) + '<strong>' + count + '</strong>')).join("") +
    '</div>' + panel('<h2>Upcoming bookings</h2>' + bookingRows(state));
    case 1: return panel(settings(state));
    case 2: return panel(rows(Object.values(state.conversations).map(item =>
      '<details><summary>' + esc(item.name) + '</summary>' + transcript(item) + '</details>'), "No conversations yet."));
    case 3: return panel(bookingRows(state));
    case 4: return panel(rows(state.jobs.map(item => '<strong>' + esc(item.status) + '</strong> · ' + date(item.due) +
      '<p>' + esc(item.text) + '</p>'), "No follow-ups scheduled.") +
      (isDemo ? '<form id="dispatch"><button>Simulate delivery for due follow-ups</button></form>' : ""));
    case 5: return panel('<p>Subscription status: <strong>' + esc(state.billing) + '</strong></p>' +
      '<form id="billing"><button>' + (isDemo ? "Toggle simulated subscription" :
      ["active", "trialing", "past_due", "unpaid"].includes(state.billing) ? "Manage subscription" : "Open checkout") + '</button></form>');
  }
}
function bookingRows(state) {
  return rows(state.bookings.map(item => '<strong>' + esc(item.service) + '</strong> · ' +
    date(item.start) + '<br><small>' + esc(item.name) + ' · ' + esc(item.member) + '</small>'), "No bookings yet.");
}
function transcript(item) {
  return item.messages.map(message => '<div class="bubble ' + (message.speaker === "You" ? "you" : "") + '"><small>' +
    esc(message.speaker) + '</small><br>' + esc(message.text) + '</div>').join("");
}
const errorArea = '<p id="error" role="status" class="notice"></p>';
async function workspace(message = "") {
  const page = Math.max(0, pages.indexOf(decodeURIComponent(location.hash.slice(1))));
  const state = await api("workspace");
  app.innerHTML = '<div class="shell"><aside class="rail"><div class="brand">Roofline</div><nav>' +
    pages.map((label,index) => '<a href="#' + encodeURIComponent(label) + '"' +
      (index === page ? ' aria-current="page"' : '') + '>' + label + '</a>').join("") +
    '</nav></aside><main class="content"><div class="header"><div><small>' + esc(state.industry) + '</small><h1>' +
    esc(state.name) + '</h1></div></div>' +
    '<section class="panel share"><div><strong>Your customer receptionist link</strong><br><small>Share this link with your customers.</small></div>' +
    '<input aria-label="Customer receptionist URL" readonly value="' +
    esc(new URL(href("reception", company), location.href).href) + '"><a class="button" href="' +
    esc(href("reception",company)) + '" target="_blank" rel="noopener">Open receptionist</a></section>' +
    preview + (isDemo ? '<p>Company · <a href="?company=cedar">Cedar</a> · <a href="?company=willow">Willow</a></p>' :
    '<p><a href="/">Switch company</a></p>') +
    (page ? '<h2>' + pages[page] + '</h2>' : '') + errorArea + workspaceView(page,state) + '</main></div>';
  document.getElementById("error").textContent = message;
  bind("settings", async data => { await api("settings", config(data)); await workspace("Settings saved."); });
  bind("dispatch", async () => { await api("dispatch", {}); await workspace("Due jobs processed in demo mode."); });
  bind("billing", async () => {
    const result = await api("billing", {});
    if (result?.url) location.href = result.url;
    else await workspace();
  });
}
function lines(value) { return value.split("\n").map(line => line.trim()).filter(Boolean); }
function config(data) {
  return {...data, followupMinutes: Number(data.followupMinutes), startHour: Number(data.startHour), endHour: Number(data.endHour),
    services: lines(data.services).map(line => {const [name, minutes] = line.split("|").map(x=>x.trim()); return {name, minutes:Number(minutes)};}),
    faq: lines(data.faq).map(line => {const [question, answer] = line.split("|").map(x=>x.trim()); return {question,answer};}),
    staff: lines(data.staff), questions: lines(data.questions)};
}
async function reception() {
  const started = !!currentConversation;
  const booked = currentConversation?.booked;
  app.innerHTML = '<main class="chat"><small>Roofline receptionist</small><h1>' + esc(profile.name) + '</h1>' + preview + errorArea +
    panel(started ? transcript(currentConversation) +
      '<form id="chat">' + field("Message", "text", "") + '<button>Send</button></form>' :
      '<p>' + esc(profile.greeting) + '</p><form id="start">' + field("Your name", "name", "") +
      '<label>Mobile number (optional)<input type="tel" name="phone" placeholder="+15550100100"></label>' +
      '<label><input type="checkbox" name="consent">Send me SMS follow-ups about this appointment. Reply STOP to opt out.</label><button>Start conversation</button></form>') +
    (started && !booked ? panel('<h2>Find a time</h2><form id="slots"><label>Service<select name="service">' +
        options(profile.services.map(item => item.name), preferredService) + '</select></label><label>Staff<select name="member">' +
        options(profile.staff, preferredStaff) + '</select></label><button>Show times</button></form><div id="times"></div>') : '');
  bind("start", async data => {
    currentConversation = await api("start", {...data, consent: data.consent === "on"});
    conversationToken = currentConversation.token;
    sessionStorage.setItem("roofline-chat:" + company, conversationToken);
    await reception();
    document.querySelector("#chat input")?.focus();
  });
  bind("chat", async data => {
    currentConversation = await api("chat", data, conversationToken);
    await reception();
    document.querySelector("#chat input")?.focus();
  });
  bind("slots", async data => {
    preferredService = data.service;
    preferredStaff = data.member;
    const slots = (await api("slots", data)).slice(0, 36);
    document.getElementById("times").innerHTML = slots.length ? '<form id="book"><label>Available times (UTC)<select name="start">' +
      slots.map(item => '<option value="' + esc(item.start) + '">' + date(item.start) + '</option>').join("") +
      '</select></label><button>Confirm booking</button></form>' : '<p>No times available.</p>';
    bind("book", async time => { currentConversation = await api("book", {...data,...time}, conversationToken); await reception(); });
  });
}
function options(items, selected) {
  return items.map(item => '<option' + (item === selected ? ' selected' : '') + '>' + esc(item) + '</option>').join("");
}
async function account() {
  const response = await fetch("/account");
  const data = await response.json();
  app.innerHTML = '<main class="login"><h1>Roofline</h1>' + errorArea +
    (data.authenticated ? panel('<h2>Your companies</h2>' + rows(data.companies.map(item => '<a href="' +
      esc(href("company", item.id)) + '">' + esc(item.name) + '</a>'), 'Create your first company.') +
      '<form id="account">' + field("Company name","name","") + field("Industry","industry","") +
      '<button>Create company</button></form><form id="logout"><button>Sign out</button></form>') :
      panel('<form id="account">' + field("Email","email","","email") + field("Password (at least 12 characters)","password","","password") +
      '<label><input type="checkbox" name="register">Create a new account</label><button>Continue</button></form>'));
  bind("account", async input => {
    const result = await fetch("/account", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
    const value = await result.json();
    if (!result.ok) throw new Error(value.error);
    location.href = value.id ? href("company", value.id) : "/";
  });
  bind("logout", async () => { await fetch("/logout",{method:"POST"}); location.href = "/"; });
}
async function main() {
  if (customer) {
    profile = await api("public");
    if (conversationToken) {
      try {currentConversation = await api("chat", undefined, conversationToken);}
      catch {sessionStorage.removeItem("roofline-chat:" + company); conversationToken = null;}
    }
    await reception();
  } else if (company) await workspace();
  else await account();
}
function report(error) {
  app.innerHTML = '<main class="login"><h1>Roofline</h1><p role="alert">' + esc(error.message) + '</p><a href="/">Return to Roofline</a></main>';
}
window.addEventListener("hashchange", () => { if (!customer && company) workspace().catch(report); });
main().catch(report);
