import {company, startConversation, receive, available, book} from "./domain.mjs";
const key = "roofline-demo-v1";
export async function demo(path, input) {
  const data = JSON.parse(localStorage.getItem(key) || "null") || {
    cedar: company("Cedar Home Services", "Home maintenance"),
    willow: company("Willow Wellness", "Wellness")
  };
  const [id, action, conversationId] = path.split("/");
  const state = Object.hasOwn(data, id) && data[id];
  if (!state) throw new Error("Company not found.");
  let result;
  if (action === "workspace") result = state;
  if (action === "settings") Object.assign(state, input);
  if (action === "public") result = publicProfile(state);
  if (action === "start") {
    const token = crypto.randomUUID();
    result = {token, ...startConversation(state, input, token)};
  }
  if (action === "slots") result = available(state, input.service, input.member);
  if (["chat", "book"].includes(action)) {
    const conversation = Object.hasOwn(state.conversations, conversationId) && state.conversations[conversationId];
    if (!conversation) throw new Error("Conversation not found.");
    if (action === "chat" && input) receive(state, conversation, input.text);
    if (action === "book") book(state, conversationId, input, crypto.randomUUID());
    result = conversation;
  }
  if (action === "dispatch") {
    for (const job of state.jobs) {
      if (job.status === "scheduled" && Date.parse(job.due) <= Date.now()) job.status = "simulated";
    }
  }
  if (action === "billing") state.billing = state.billing === "active" ? "inactive" : "active";
  if (input) localStorage.setItem(key, JSON.stringify(data));
  return result;
}
export function publicProfile({name, industry, greeting, services, staff}) {
  return {name, industry, greeting, services, staff};
}
