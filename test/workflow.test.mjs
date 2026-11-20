import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createHmac} from "node:crypto";

test("two independent companies, receptionist, bookings, follow-up and signed billing", {timeout:20000}, async t => {
  const secret = "local-test-webhook";
  const child = spawn(process.execPath,["server.mjs"],{env:{...process.env,HOST:"127.0.0.1",PORT:"0",
    ROOFLINE_DB:":memory:",STRIPE_WEBHOOK_SECRET:secret,STRIPE_SECRET_KEY:"",OPENAI_API_KEY:"",ROOFLINE_SMS_COMPANIES:"{}"}});
  t.after(()=>child.kill());
  const first = await Promise.race([once(child.stdout,"data"),once(child.stderr,"data").then(([value])=>{throw new Error(value.toString());})]);
  const base = "http://127.0.0.1:" + first[0].toString().match(/listening on (\d+)/)[1];
  async function call(path,data,cookie,extra={}) {
    const response = await fetch(base+path,{
      method:data === undefined ? "GET" : "POST",
      headers:{"Content-Type":"application/json",...(cookie ? {cookie} : {}),...extra},
      body:data === undefined ? undefined : typeof data === "string" ? data : JSON.stringify(data)
    });
    return {status:response.status,value:await response.json(),cookie:response.headers.get("set-cookie")?.split(";")[0]};
  }
  async function create(email,name,industry) {
    const {cookie,status} = await call("/account",{email,password:"local test password",register:true});
    assert.equal(status,200);
    const result = await call("/account",{name,industry},cookie);
    assert.equal(result.status,200);
    return {cookie,id:result.value.id,path:"/api/"+result.value.id};
  }
  const a = await create("a@example.test","Cedar","Home maintenance");
  const b = await create("b@example.test","Willow","Wellness");
  assert.deepEqual((await call("/account",undefined,b.cookie)).value.companies,[{id:b.id,name:"Willow"}]);
  for (const [action,data] of [["workspace",undefined],["settings",{}],["billing",{}]]) {
    assert.equal((await call(a.path+"/"+action,data,b.cookie)).status,403);
  }
  const workspace = async who => (await call(who.path+"/workspace",undefined,who.cookie)).value;
  const config = {...await workspace(a),questions:["What needs fixing?"],followupMinutes:0,faq:[
    {question:"Service area",answer:"We serve Cedar County."}
  ],billing:"active"};
  assert.equal((await call(a.path+"/settings",config,a.cookie)).status,200);
  assert.equal((await workspace(a)).billing,"inactive");
  assert.deepEqual((await workspace(b)).questions,["What can we help you with?"]);
  const start = async (name,consent) => {
    const result=await call(a.path+"/start",{name,phone:"+15550100100",consent});
    assert.equal(result.status,201);
    assert.equal(result.value.messages.at(-1).text,"What needs fixing?");
    return result.value.token;
  };
  const token = await start("Customer A",true);
  const other = await start("Customer B",false);
  assert.equal((await call(b.path+"/chat/"+token)).status,404);
  const selection = {service:"Consultation",member:"Service team"};
  const slots = await call(a.path+"/slots",selection);
  const booking = {...selection,start:slots.value[0].start};
  assert.equal((await call(a.path+"/book/"+token,booking)).status,400);
  for (const guest of [token,other]) assert.equal((await call(a.path+"/chat/"+guest,{text:"Drain repair"})).status,200);
  assert.equal((await call(a.path+"/chat/"+token,{text:"What is your service area?"})).value.messages.at(-1).text,"We serve Cedar County.");
  const results = await Promise.all([call(a.path+"/book/"+token,booking),call(a.path+"/book/"+other,booking)]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);
  const winner = results[0].status === 200 ? token : other;
  const loser = winner === token ? other : token;
  assert.equal((await call(a.path+"/book/"+winner,booking)).status,200);
  assert.equal((await call(a.path+"/book/"+loser,{...selection,start:slots.value[1].start})).status,200);
  assert.equal((await workspace(a)).bookings.length,2);
  assert.equal((await workspace(a)).jobs.length,1);
  assert.equal((await workspace(b)).bookings.length,0);
  assert.equal((await workspace(b)).conversations.length,0);

  const event = JSON.stringify({id:"evt_local",created:Math.floor(Date.now()/1000),
    type:"customer.subscription.updated",data:{object:{id:"sub_local",status:"active",customer:"cus_local",metadata:{company_id:a.id}}}});
  assert.equal((await call("/hooks/stripe",event)).status,401);
  const timestamp = Math.floor(Date.now()/1000);
  const signature = createHmac("sha256",secret).update(timestamp+"."+event).digest("hex");
  const headers = {"stripe-signature":`t=${timestamp},v1=${signature}`};
  assert.equal((await call("/hooks/stripe",event,undefined,headers)).status,200);
  assert.equal((await call("/hooks/stripe",event,undefined,headers)).status,200);
  assert.equal((await workspace(a)).billing,"active");
  assert.equal((await workspace(b)).billing,"inactive");
  assert.equal((await workspace(a)).stripeCustomer,undefined);
  for (let attempt=0; attempt<30 && (await workspace(a)).jobs[0].status==="scheduled"; attempt++) {
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal((await workspace(a)).jobs[0].status,"simulated");
});

test("company ownership survives process restart", {timeout:10000}, async t => {
  const {mkdtemp,rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(),"roofline-test-"));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      child.kill();
      await once(child,"exit");
    }
    await rm(directory,{recursive:true,force:true});
  });
  async function launch() {
    const child = spawn(process.execPath,["server.mjs"],{env:{...process.env,HOST:"127.0.0.1",PORT:"0",
      ROOFLINE_DB:join(directory,"test.sqlite")}});
    children.add(child);
    child.once("exit",()=>children.delete(child));
    const [ready] = await Promise.race([
      once(child.stdout,"data"),once(child.stderr,"data").then(([message])=>{throw new Error(message.toString());})
    ]);
    return {child,url:"http://127.0.0.1:"+ready.toString().match(/listening on (\d+)/)[1]};
  }
  const first = await launch();
  const register = await fetch(first.url+"/account",{method:"POST",body:JSON.stringify({
    email:"owner@example.test",password:"durable test password",register:true
  })});
  assert.equal(register.status,200);
  const cookie = register.headers.get("set-cookie").split(";")[0];
  const created = await fetch(first.url+"/account",{method:"POST",headers:{cookie},body:JSON.stringify({
    name:"Durable Service",industry:"Maintenance"
  })});
  assert.equal(created.status,200);
  const {id} = await created.json();
  first.child.kill();
  await once(first.child,"exit");
  const second = await launch();
  const response = await fetch(second.url+"/api/"+id+"/workspace",{headers:{cookie}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).name,"Durable Service");
});
