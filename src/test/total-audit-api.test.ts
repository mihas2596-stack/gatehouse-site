// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import cardHandler from "../../api/card-status";
import quoteHandler from "../../api/send-contact-email";
import cronHandler from "../../api/auto-charge";
import ownerActionHandler from "../../api/booking-action";
import visitHandler from "../../api/visit";
import ownerHandler from "../../api/owner";

const SECRET = "sk_test_total_audit";
const BID = "audit-existing-bid";
const row: Record<string, unknown> = { id: "audit-row", booking_id: BID, status: "requested", amount_cents: 18400, service: "Standard", visit_date: "2026-11-16" };
let emails: Record<string, unknown>[], inserts: Record<string, unknown>[], events: Record<string, unknown>[], failEventWrites: boolean;
let oldVisits: Record<string, unknown>[], photoRows: Record<string, unknown>[], deletePhotoRequests: string[], failStorage: boolean;
let ownerRows: Record<string, unknown>[];
let foreignBinding: boolean, failVisitUpdates: boolean, failVisitInsert: boolean;
function response() { return { code: 0, body: {} as Record<string, unknown>, status(n: number) { this.code=n;return this; }, json(b: Record<string, unknown>) { this.body=b; }, setHeader: vi.fn(), end: vi.fn() }; }
function token() { const key=createHash("sha256").update(`gatehouse-booking-link:${SECRET}`).digest(); const iv=randomBytes(12); const c=createCipheriv("aes-256-gcm",key,iv); const ct=Buffer.concat([c.update(JSON.stringify({bid:BID,email:"audit@example.com",name:"Current Booking Name",ts:Math.floor(Date.now()/1000),first:"184",service:"Standard",date:"2026-11-16"})),c.final()]);return `v2.${Buffer.concat([iv,c.getAuthTag(),ct]).toString("base64url")}`; }
const ok=(data: unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data,text:async()=>JSON.stringify(data)});
beforeEach(()=>{
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
 ownerRows=[];row.is_test=false;emails=[];inserts=[];events=[];failEventWrites=false;oldVisits=[];photoRows=[];deletePhotoRequests=[];failStorage=false;row.status="requested";row.client_email="audit@example.com";foreignBinding=false;failVisitUpdates=false;failVisitInsert=false;
 vi.stubEnv("ADMIN_TOKEN","audit-owner");
 vi.stubEnv("STRIPE_SECRET_KEY",SECRET);vi.stubEnv("RESEND_API_KEY","audit-mail");vi.stubEnv("SUPABASE_URL","https://audit.supabase.co");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","audit-db");vi.stubEnv("CRON_SECRET","audit-cron");
 vi.spyOn(console,"log").mockImplementation(()=>{});vi.spyOn(console,"error").mockImplementation(()=>{});
 vi.stubGlobal("fetch",vi.fn(async(url: string,init?: RequestInit)=>{
  const u=new URL(String(url)),m=init?.method??"GET";const data=()=>JSON.parse(String(init?.body??"{}"));
  if(u.hostname==="api.resend.com"){emails.push(data());return ok({id:"audit-email"});}
  if(u.hostname==="api.stripe.com"){
   if(u.pathname.endsWith("/customers/search")) { const q=u.searchParams.get("query")??"";if(q.includes("gh_state"))return ok({data:[]});if(foreignBinding&&q.includes("gh_booking_id"))return ok({data:[]});return ok({data:[{id:"cus_audit",email:"audit@example.com",name:"Previous Person",metadata:{gh_booking_id:foreignBinding?"another-booking":BID,gh_payment_method:"pm_audit",gh_state:foreignBinding?"cancelled":"awaiting_card"}}]}); }
   if(u.pathname.endsWith("/checkout/sessions/cs_test_audit"))return ok({id:"cs_test_audit",mode:"setup",status:"complete",customer:"cus_audit",client_reference_id:BID,setup_intent:"seti_audit"});
   if(u.pathname.endsWith("/setup_intents/seti_audit"))return ok({id:"seti_audit",status:"succeeded",payment_method:"pm_audit"});
   if(u.pathname.endsWith("/payment_methods/pm_audit"))return ok({id:"pm_audit",card:{brand:"visa",last4:"4242"},customer:"cus_audit"});
   if(u.pathname.endsWith("/payment_methods"))return ok({data:[{id:"pm_audit",card:{brand:"visa",last4:"4242"}}]});
   if(u.pathname.endsWith("/customers"))return ok({data:[]});
   return ok({id:"cus_audit",email:"audit@example.com",name:"Previous Person",metadata:{}});
  }
  if(u.hostname==="audit.supabase.co"){
   const table=u.pathname.split("/").pop();
   if(u.pathname.includes("/storage/v1/object/")&&m==="DELETE")return ok({},failStorage?503:200);
   if(table==="gh_visits"){
    if(m==="PATCH"){if(failVisitUpdates)return ok({},503);Object.assign(row,data());return ok([row]);}
    if(m==="POST"){inserts.push(data());return failVisitInsert ? ok({},503) : ok([{id:"new-audit-row"}]);}
    if(u.searchParams.get("report_sent_at")?.startsWith("lt."))return ok(oldVisits.slice(0,Number(u.searchParams.get("limit")??100)));
    if(u.searchParams.has("booking_id"))return ok(u.searchParams.get("booking_id")==="eq."+BID?[row]:[]);
    const offset=Number(u.searchParams.get("offset")??0),limit=Number(u.searchParams.get("limit")??100);return ok(ownerRows.slice(offset,offset+limit));
   }
   if(table==="gh_events"){
    if(m==="POST"){if(failEventWrites)return ok({},503);const e={id:events.length+1,created_at:new Date().toISOString(),...data()};events.push(e);return ok([e]);}
    let out=events.filter(e=>!u.searchParams.get("booking_id")||e.booking_id===BID);
    const ev=u.searchParams.get("event");if(ev?.startsWith("eq."))out=out.filter(e=>e.event===ev.slice(3));return ok(out.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))));
   }
   if(table==="gh_photos"){
    if(m==="DELETE"){deletePhotoRequests.push(u.searchParams.get("id")??"");photoRows=photoRows.filter(p=>"eq."+p.id!==u.searchParams.get("id"));return ok([]);}
    if(u.searchParams.get("select")?.includes("gh_visits!inner")) return ok(u.searchParams.get("gh_visits.report_sent_at")==="is.null" ? [] : photoRows.filter(p=>oldVisits.some(v=>v.id===p.visit_id)));
    return ok(photoRows.filter(p=>"eq."+p.visit_id===u.searchParams.get("visit_id")));
   }
   return ok([]);
  }
  throw new Error("Unstubbed external request "+u.hostname+u.pathname);
 }));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();vi.useRealTimers();});
const cardPost=async()=>{const r=response();await cardHandler({method:"POST",headers:{},body:{action:"confirm_card",bt:token()}},r as never);return r;};
const cron=async()=>{const r=response();await cronHandler({method:"GET",headers:{authorization:"Bearer audit-cron"}},r as never);return r;};


const quoteRequest = (extra: Record<string, unknown> = {}) => ({method:"POST",headers:{origin:"https://www.gatehousehomecleaning.com"},body:{request_id:"f9526ec4-dd4f-46b4-a5e9-a7effc02c5ff",name:"Audit QA",email:"audit@example.com",phone:"7705550100",source:"quote",service:"Standard",service_key:"standard",frequency:"onetime",bedrooms:"1",bathrooms:"1",full_baths:"1",half_baths:"0",zip:"30024",date:"2026-11-20",time:"morning",address:"100 Test Street, Suwanee, GA 30024",terms_consent:true,photo_consent:true,cleaned_recently:true,entry_method:"home",...extra}});

describe("additional audit acceptance criteria — intended behavior",()=>{
 it("saving a card cannot claim success when its authoritative event failed to persist",async()=>{failEventWrites=true;const r=await cardPost();expect(r.body.ok).toBe(false);});
 it("verified Checkout cannot claim success if the booking card event was not stored",async()=>{failEventWrites=true;const r=response();await cardHandler({method:"GET",headers:{},query:{bt:token(),session_id:"cs_test_audit"}},r as never);expect(r.code).toBe(503);expect(r.body.verified).toBe(false);expect(emails).toHaveLength(0);});
 it("verified Checkout records the exact SetupIntent card before reporting saved",async()=>{const r=response();await cardHandler({method:"GET",headers:{},query:{bt:token(),session_id:"cs_test_audit"}},r as never);expect(r.code).toBe(200);expect(r.body.verified).toBe(true);expect(events.some(e=>e.event==="card_confirmed"&&(e.detail as Record<string,unknown>).payment_method_id==="pm_audit")).toBe(true);});
 it("a card-saved email addresses the current booking's submitted name",async()=>{await cardPost();expect(String(emails.find(e=>String(e.subject).startsWith("Card saved"))?.text)).toContain("Hi Current");});
 it("a cancelled visit with an earlier confirmation does not return active booking confirmation",async()=>{row.status="cancelled";events=[{booking_id:BID,event:"visit_confirmed",detail:{date:"2026-11-16",window:"morning"},created_at:new Date().toISOString()}];const r=response();await cardHandler({method:"GET",headers:{},query:{bt:token()}},r as never);expect((r.body.booking as Record<string,string>)?.booking_confirmed).not.toBe("1");});
 it("a paid oven extra appears in the cleaner's persistent work checklist",async()=>{
  const r=response();await quoteHandler({method:"POST",headers:{origin:"https://www.gatehousehomecleaning.com"},body:{request_id:"e9526ec4-dd4f-46b4-a5e9-a7effc02c5ff",name:"Audit QA",email:"audit@example.com",phone:"7705550100",source:"quote",service:"Standard",service_key:"standard",frequency:"onetime",bedrooms:"1",bathrooms:"1",full_baths:"1",half_baths:"0",zip:"30024",date:"2026-11-20",time:"morning",address:"100 Test Street, Suwanee, GA 30024",terms_consent:true,photo_consent:true,cleaned_recently:true,entry_method:"home",addons:{insideOven:true}}},r as never);
  expect(r.code).toBe(200);expect(inserts[0]?.amount_cents).toBe(18400);expect(JSON.stringify(inserts[0]?.checklist)).toMatch(/oven/i);
 });
 it("retention reaches visit 21 after the first 20 old visits have no photos",async()=>{
  oldVisits=Array.from({length:21},(_,i)=>({id:"old-"+i,booking_id:"old-bid-"+i}));photoRows=[{id:"photo-last",visit_id:"old-20",storage_path:"visits/old-20/photo.jpg"}];await cron();await cron();expect(deletePhotoRequests).toContain("eq.photo-last");
 });
 it("a storage-delete failure preserves the database row so deletion can be retried",async()=>{oldVisits=[{id:"old-1",booking_id:"old-bid-1"}];photoRows=[{id:"retry-photo",visit_id:"old-1",storage_path:"visits/old-1/photo.jpg"}];failStorage=true;await cron();expect(deletePhotoRequests).toHaveLength(0);});
 it("a new requested booking does not inherit the cancelled state of an older booking with the same email",async()=>{foreignBinding=true;const r=response();await ownerActionHandler({method:"POST",headers:{authorization:"Bearer audit-owner"},body:{action:"status",booking_id:BID}},r as never);expect(r.code).toBe(200);expect(r.body.state).not.toBe("cancelled");});
 it("a cancellation does not claim success when both its visit and journal writes failed",async()=>{failVisitUpdates=true;failEventWrites=true;const r=response();await visitHandler({method:"POST",headers:{},body:{action:"cancel",scope:"once",bt:token()}},r as never);expect(r.body.ok).toBe(false);});
 it("a failed booking insert sends no success emails",async()=>{failVisitInsert=true;const r=response();await quoteHandler(quoteRequest(),r as never);expect(r.body.ok).toBe(false);expect(emails).toHaveLength(0);});
 it("first deep clean is explicit in the stored service and work scope",async()=>{const r=response();await quoteHandler(quoteRequest({cleaned_recently:false}),r as never);expect(r.code).toBe(200);expect(inserts[0]?.service).toMatch(/deep/i);expect(JSON.stringify(inserts[0]?.checklist)).toMatch(/Inside oven cleaned/);expect(JSON.stringify(inserts[0]?.checklist)).toMatch(/Inside fridge cleaned/);});
 it("untrusted extra-area and scope text stays escaped in owner email",async()=>{const r=response();await quoteHandler(quoteRequest({extra_zones:'<img src="x" onerror="bad">',scope_review:true,scope_reasons:'<a href="x">fake</a>'}),r as never);expect(r.code).toBe(200);const html=String(emails.find(e=>String(e.subject).startsWith("New quote"))?.html);expect(html).not.toContain('<img src="x"');expect(html).not.toContain('<a href="x">');expect(html).toContain('&lt;img');});
 it("confirmation deadline is pinned to the original request",async()=>{events=[{booking_id:BID,event:"visit_created",created_at:"2026-11-02T12:00:00Z",detail:{}}];const r=response();await cardHandler({method:"GET",headers:{},query:{bt:token()}},r as never);expect((r.body.booking as Record<string,string>).confirm_by).toContain("November 3");});

 it("next-visit invitation sends one review link and does not create a booking",async()=>{row.status="paid";const r=response();await ownerActionHandler({method:"POST",headers:{authorization:"Bearer audit-owner"},body:{action:"invite_next_visit",booking_id:BID}},r as never);expect(r.body.email_sent).toBe(true);expect(emails).toHaveLength(1);expect(String(emails[0].text)).toContain("/quote?service=standard&frequency=every2weeks");expect(inserts).toHaveLength(0);const again=response();await ownerActionHandler({method:"POST",headers:{authorization:"Bearer audit-owner"},body:{action:"invite_next_visit",booking_id:BID}},again as never);expect(again.body.already_sent).toBe(true);expect(emails).toHaveLength(1);});
 it("owner test flag is durably updated and database failures are visible",async()=>{const r=response();await ownerActionHandler({method:"POST",headers:{authorization:"Bearer audit-owner"},body:{action:"set_test_booking",booking_id:BID,is_test:true}},r as never);expect(r.body.ok).toBe(true);expect(row.is_test).toBe(true);failVisitUpdates=true;const failed=response();await ownerActionHandler({method:"POST",headers:{authorization:"Bearer audit-owner"},body:{action:"set_test_booking",booking_id:BID,is_test:false}},failed as never);expect(failed.body.ok).toBe(false);expect(row.is_test).toBe(true);});
 it("owner pagination reaches visits beyond the first hundred without duplication",async()=>{ownerRows=Array.from({length:110},(_,i)=>({id:"page-"+i,booking_id:"page-bid-"+i,status:"requested",report_status:"none"}));const first=response();await ownerHandler({method:"GET",headers:{authorization:"Bearer audit-owner"},query:{view:"list"}},first as never);expect((first.body.visits as unknown[])).toHaveLength(100);expect(first.body.next_offset).toBe(100);const second=response();await ownerHandler({method:"GET",headers:{authorization:"Bearer audit-owner"},query:{view:"list",offset:"100"}},second as never);expect((second.body.visits as Record<string,unknown>[]).map(v=>v.id)).toEqual(ownerRows.slice(100).map(v=>v.id));expect(second.body.next_offset).toBeNull();});

});
