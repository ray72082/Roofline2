import {createHmac,timingSafeEqual} from "node:crypto";
const env = process.env;
const fail = (message,status=503) => {throw Object.assign(new Error(message),{status});};
const credentials = id => JSON.parse(env.ROOFLINE_SMS_COMPANIES || "{}")[id];
const origin = () => {
  if (!env.ROOFLINE_ORIGIN) fail("Configure the public Roofline URL.");
  return new URL(env.ROOFLINE_ORIGIN).origin;
};
async function request(url,options) {
  const response = await fetch(url,{...options,signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error("Provider returned HTTP " + response.status);
  return response.json();
}
function stripe(path,values,key) {
  return request("https://api.stripe.com/v1/"+path,{
    method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(values)
  });
}

export async function checkout(store,id,state) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !env.STRIPE_PRICE_ID || !env.STRIPE_WEBHOOK_SECRET) fail("Stripe billing needs provider configuration.");
  const returnUrl = origin()+"/?company="+id+"#Billing";
  try {
    if (state.stripeCustomer && ["active","trialing","past_due","unpaid"].includes(state.billing)) {
      const portal = await stripe("billing_portal/sessions",{customer:state.stripeCustomer,return_url:returnUrl},key);
      return {url:portal.url};
    }
    const session = await stripe("checkout/sessions",{
      mode:"subscription","line_items[0][price]":env.STRIPE_PRICE_ID,"line_items[0][quantity]":"1",
      "subscription_data[metadata][company_id]":id,client_reference_id:id,
      ...(state.stripeCustomer ? {customer:state.stripeCustomer} : {}),
      success_url:returnUrl,cancel_url:returnUrl
    },key);
    return {url:session.url};
  } catch {fail("Stripe checkout is temporarily unavailable.",502);}
}

function equals(a,b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left,right);
}
export async function stripeEvent(store,req,raw) {
  if (!env.STRIPE_WEBHOOK_SECRET) fail("Stripe webhook is disabled.");
  const fields = (req.headers["stripe-signature"] || "").split(",").map(item=>item.trim().split("="));
  const timestamp = fields.find(([key])=>key === "t")?.[1];
  const expected = createHmac("sha256",env.STRIPE_WEBHOOK_SECRET).update(timestamp+"."+raw).digest("hex");
  if (!/^\d+$/.test(timestamp || "") || Math.abs(Date.now()/1000-Number(timestamp)) > 300 ||
      !fields.some(([key,value])=>key === "v1" && value && equals(expected,value))) fail("Invalid Stripe signature.",401);
  const event = JSON.parse(raw);
  if (!["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"].includes(event.type)) return {};
  const subscription = event.data.object;
  const id = subscription.metadata?.company_id;
  if (!id) return {};
  store.once("stripe",event.id,() => {
    const state = store.load(id);
    if (state.stripeEventAt > event.created) return;
    if (state.stripeSubscription && state.stripeSubscription !== subscription.id &&
      ["active","trialing","past_due","unpaid"].includes(state.billing)) return;
    Object.assign(state,{billing:subscription.status,stripeSubscription:subscription.id,
      stripeCustomer:subscription.customer,stripeEventAt:event.created});
    store.save(id,state);
  });
  return {};
}

export async function modelReply(state,messages) {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const response = await request("https://api.openai.com/v1/responses",{
      method:"POST",headers:{Authorization:"Bearer "+env.OPENAI_API_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({model:env.OPENAI_MODEL || "gpt-4.1-mini",store:false,max_output_tokens:250,
        instructions:"You are a service receptionist. Use only the supplied company facts. Never confirm prices or bookings. When facts are missing refer the visitor to the company. Company facts: "+
          JSON.stringify({name:state.name,industry:state.industry,services:state.services,faq:state.faq}),
        input:messages.slice(0,-1).slice(-12).map(item=>({role:item.speaker==="You"?"user":"assistant",content:item.text}))
      })
    });
    return response.output?.flatMap(item=>item.content || []).find(item=>item.type==="output_text")?.text || null;
  } catch {return null;}
}

export async function dispatch(store) {
  for (const {id} of store.all("SELECT id FROM companies")) {
    const sms = credentials(id);
    for (const job of store.load(id).jobs) {
      if (job.status !== "scheduled" || Date.parse(job.due) > Date.now()) continue;
      const claimed = store.mutate(id,state => {
        const candidate = state.jobs.find(item=>item.id===job.id);
        if (candidate.status !== "scheduled") return false;
        if (state.smsOptOut?.includes(job.phone)) {
          candidate.status = "opted_out";
          return false;
        }
        candidate.status = sms ? "sending" : "simulated";
        return !!sms;
      });
      if (!claimed) continue;
      let status = "failed";
      let providerId;
      try {
        const message = await request(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sms.accountSid)}/Messages.json`,{
          method:"POST",headers:{Authorization:"Basic "+Buffer.from(sms.accountSid+":"+sms.authToken).toString("base64"),
            "Content-Type":"application/x-www-form-urlencoded"},
          body:new URLSearchParams({MessagingServiceSid:sms.messagingServiceSid,To:job.phone,Body:job.text})
        });
        providerId = message.sid;
        status = "submitted";
      } catch (error) {
        if (!error.message.startsWith("Provider returned HTTP 4")) status = "delivery_unknown";
      }
      store.mutate(id,state=>Object.assign(state.jobs.find(item=>item.id===job.id),{status,providerId}));
    }
  }
}

export function optOut(store,req,path,raw) {
  const id = path.split("/").at(-1);
  const sms = credentials(id);
  if (!sms) fail("SMS webhook is disabled.");
  const fields = Object.fromEntries(new URLSearchParams(raw));
  const signed = origin()+path+Object.keys(fields).sort().map(key=>key+fields[key]).join("");
  const expected = createHmac("sha1",sms.authToken).update(signed).digest("base64");
  if (!equals(expected,req.headers["x-twilio-signature"] || "") || fields.AccountSid !== sms.accountSid) fail("Invalid SMS signature.",401);
  if (fields.OptOutType === "STOP" || /^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)$/i.test(fields.Body?.trim())) {
    store.mutate(id,state=>{
      state.smsOptOut = [...new Set([...(state.smsOptOut || []),fields.From])];
      for (const job of state.jobs) if (job.phone===fields.From && job.status==="scheduled") job.status="opted_out";
    });
  }
  return {};
}
