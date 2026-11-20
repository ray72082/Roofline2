import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash} from "node:crypto";
import {company, startConversation, receive, available, book} from "./public/domain.mjs";
import {publicProfile} from "./public/demo.mjs";
import {checkout, stripeEvent, dispatch, modelReply, optOut} from "./providers.mjs";

const env = process.env;
const db = new DatabaseSync(env.ROOFLINE_DB || "roofline.sqlite");
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (company_id TEXT REFERENCES companies(id), user_id TEXT REFERENCES users(id), PRIMARY KEY(company_id,user_id));
CREATE TABLE IF NOT EXISTS event_log (provider TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(provider,id));
`);
const find = (sql,...args) => db.prepare(sql).get(...args);
const all = (sql,...args) => db.prepare(sql).all(...args);
const run = (sql,...args) => db.prepare(sql).run(...args);
function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = callback(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const save = (id,state) => run("UPDATE companies SET state=? WHERE id=?", JSON.stringify(state),id);
function mutate(id, callback) {
  return transaction(() => {
    const state = load(id);
    const value = callback(state);
    save(id,state);
    return value;
  });
}
function fail(message, status = 400) { throw Object.assign(new Error(message),{status}); }
function load(id) {
  const row = find("SELECT state FROM companies WHERE id=?", id);
  if (!row) fail("Company not found.",404);
  return JSON.parse(row.state);
}
function authenticate(req) {
  const token = req.headers.cookie?.match(/(?:^|; )roofline=([a-f0-9]{64})(?:;|$)/)?.[1];
  return token && find("SELECT user_id FROM sessions WHERE token=? AND expires>?", digest(token), Date.now())?.user_id;
}
const digest = value => createHash("sha256").update(value).digest("hex");
const cookie = token => `roofline=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 604800 : 0}${env.ROOFLINE_SECURE_COOKIE === "1" ? "; Secure" : ""}`;
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) fail("Request too large.",413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function parse(raw) {
  try {
    const result = JSON.parse(raw);
    if (result && typeof result === "object" && !Array.isArray(result)) return result;
  } catch {}
  fail("Invalid request body.");
}
const bounded = (value, limit, min = 1) => typeof value === "string" && value.trim().length >= min && value.length <= limit;
function validateConfig(data) {
  const {name,industry,greeting,questions,faq,services,staff,startHour,endHour,followupMinutes,followup} = data;
  const integer = (value,min,max) => Number.isInteger(value) && value >= min && value <= max;
  const list = (value, valid, min = 0) => Array.isArray(value) && value.length >= min && value.length <= 30 && value.every(valid);
  if (!bounded(name,120) || !bounded(industry,120) || !bounded(greeting,1000) ||
      !list(questions,x=>bounded(x,300)) || !list(faq,x=>x && bounded(x.question,300) && bounded(x.answer,1000)) ||
      !list(services,x=>x && bounded(x.name,100) && integer(x.minutes,15,480),1) ||
      !list(staff,x=>bounded(x,100),1) || !integer(startHour,0,23) || !integer(endHour,startHour+1,24) ||
      !integer(followupMinutes,0,43200) || !bounded(followup,500,0) ||
      new Set(staff).size !== staff.length || new Set(services.map(x=>x.name)).size !== services.length ||
      services.some(service => service.minutes > (endHour - startHour) * 60)) fail("Check your settings. Staff and service names must be unique, and each service must fit your opening hours.");
  return {name,industry,greeting,questions,faq,services,staff,startHour,endHour,followupMinutes,followup};
}
function member(req,id) {
  const user = authenticate(req);
  if (!user || !find("SELECT 1 FROM members WHERE company_id=? AND user_id=?",id,user)) fail("Company access required.",403);
}
function conversation(state,token) {
  if (!token || !Object.hasOwn(state.conversations,token)) fail("Conversation not found.",404);
  return state.conversations[token];
}
function account(req,res,data) {
  const userId = authenticate(req);
  if (!data) return {authenticated:!!userId,companies:userId ? all(
    "SELECT c.id, json_extract(c.state,'$.name') AS name FROM companies c JOIN members m ON c.id=m.company_id WHERE m.user_id=?",userId) : []};
  if (userId) {
    if (!bounded(data.name,120) || !bounded(data.industry,120)) fail("Enter a company name and industry.");
    const id = randomUUID();
    transaction(() => {
      run("INSERT INTO companies VALUES (?,?)",id,JSON.stringify(company(data.name.trim(),data.industry.trim())));
      run("INSERT INTO members VALUES (?,?)",id,userId);
    });
    return {id};
  }
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const password = data.password;
  if (!bounded(email,254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !bounded(password,128,12)) fail("Enter a valid email and a password of at least 12 characters.");
  let user = find("SELECT * FROM users WHERE email=?",email);
  if (data.register) {
    if (user) fail("Account could not be created.",409);
    const salt = randomBytes(16).toString("hex");
    user = {id:randomUUID(),email,password:salt+":"+scryptSync(password,salt,64).toString("hex")};
    run("INSERT INTO users VALUES (?,?,?)",user.id,email,user.password);
  } else {
    const [salt, hash] = user?.password.split(":") || ["missing", "00".repeat(64)];
    if (!timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,"hex")) || !user) fail("Invalid credentials.",401);
  }
  const token = randomBytes(32).toString("hex");
  run("INSERT INTO sessions VALUES (?,?,?)",digest(token),user.id,Date.now()+604800000);
  res.setHeader("Set-Cookie",cookie(token));
  return {authenticated:true};
}
function once(provider,id,callback) {
  return transaction(() => {
    if (!run("INSERT OR IGNORE INTO event_log VALUES (?,?)",provider,id).changes) return;
    callback();
  });
}
const store = {load,save,mutate,once,all};
const assets = new Map([["/","index.html"],["/style.css","style.css"],["/app.mjs","app.mjs"],["/demo.mjs","demo.mjs"],["/domain.mjs","domain.mjs"]]);
const types = {html:"text/html",css:"text/css",mjs:"text/javascript"};
const limits = new Map();
const interval = setInterval(() => {limits.clear();},60000);
interval.unref();
let working = false;
async function processJobs() {
  if (working) return;
  working = true;
  try {await dispatch(store);} catch (error) {console.error("Follow-up worker:", error.message);}
  finally {working = false;}
}
const worker = setInterval(processJobs, 5000);
worker.unref();

function viewConversation(item) {
  return {messages:item.messages,booked:!!item.booked};
}
const server = createServer(async (req,res) => {
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Cache-Control","no-store");
  const json = (status,value) => {
    res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});
    res.end(JSON.stringify(value));
  };
  try {
    const pathname = new URL(req.url,"http://localhost").pathname;
    const post = req.method === "POST";
    if (!post && req.method !== "GET") fail("Method not allowed.",405);
    if (!post && assets.has(pathname)) {
      const file = assets.get(pathname);
      let content = readFileSync(new URL("./public/"+file,import.meta.url),"utf8");
      if (pathname === "/") content = content.replace('<script type="module"', '<script src="/mode.js"></script><script type="module"');
      res.writeHead(200,{"Content-Type":types[file.split(".").at(-1)]+"; charset=utf-8"});
      return res.end(content);
    }
    if (!post && pathname === "/mode.js") {
      res.writeHead(200,{"Content-Type":"text/javascript; charset=utf-8"});
      return res.end("globalThis.ROOFLINE_SERVER=true;");
    }
    if (post && pathname === "/hooks/stripe") return json(200,await stripeEvent(store,req,await body(req)));
    if (post && /^\/hooks\/sms\/[a-f0-9-]{36}$/.test(pathname)) return json(200,optOut(store,req,pathname,await body(req)));
    if (post) {
      const ip = req.socket.remoteAddress;
      const key = ip + (pathname === "/account" ? ":auth" : ":api");
      const count = (limits.get(key) || 0) + 1;
      limits.set(key,count);
      if (count > (pathname === "/account" ? 12 : 120)) fail("Try again in a minute.",429);
      if (req.headers["sec-fetch-site"] === "cross-site") fail("Cross-site request rejected.",403);
    }
    const data = post && pathname !== "/logout" ? parse(await body(req)) : null;
    if (pathname === "/account") return json(200,account(req,res,data));
    if (post && pathname === "/logout") {
      const token = req.headers.cookie?.match(/(?:^|; )roofline=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (token) run("DELETE FROM sessions WHERE token=?",digest(token));
      res.setHeader("Set-Cookie",cookie(""));
      return json(200,{});
    }
    const match = pathname.match(/^\/api\/([a-f0-9-]{36})\/([a-z]+)(?:\/([a-f0-9-]{36}))?$/);
    if (!match) fail("Page not found.",404);
    const [,id,action,token] = match;
    if (["workspace","settings","billing"].includes(action)) member(req,id);
    const state = load(id);
    if (action === "workspace" && !post) {
      const {stripeCustomer,stripeSubscription,conversations,...workspace} = state;
      return json(200,{...workspace,conversations:Object.values(conversations)});
    }
    if (action === "settings" && post) return json(200,mutate(id,current => {
      Object.assign(current,validateConfig(data)); return {};
    }));
    if (action === "billing" && post) return json(200,await checkout(store,id,state));
    if (action === "public" && !post) return json(200,publicProfile(state));
    if (action === "start" && post) {
      const token = randomUUID();
      return json(201,mutate(id,current => ({token,...viewConversation(startConversation(current,data,token))})));
    }
    if (action === "slots" && post) return json(200,available(state,data.service,data.member));
    if (action === "chat" && !post) return json(200,viewConversation(conversation(state,token)));
    if (action === "chat" && post) {
      const result = mutate(id,current => {
        const item = conversation(current,token);
        const intake = item.answers.length < current.questions.length;
        receive(current,item,data.text);
        return {version:item.messages.length,intake,...viewConversation(item)};
      });
      const reply = result.intake ? null : await modelReply(state,result.messages);
      if (reply) return json(200,mutate(id,current => {
        const item = conversation(current,token);
        if (item.messages.length === result.version) item.messages.at(-1).text = reply;
        return viewConversation(item);
      }));
      return json(200,{messages:result.messages,booked:result.booked});
    }
    if (action === "book" && post) return json(200,mutate(id,current => {
      const item = conversation(current,token);
      book(current,token,data,randomUUID());
      return viewConversation(item);
    }));
    fail("Page not found.",404);
  } catch (error) {
    if (!error.status) console.error(error);
    json(error.status || (error.constructor === Error && !error.code ? 400 : 500),
      {error:error.status || !error.code ? error.message : "Request failed."});
  }
});
server.listen(Number(env.PORT || 3000),env.HOST || "0.0.0.0",() => console.log("Roofline listening on " + server.address().port));
