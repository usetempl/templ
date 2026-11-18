import "server-only";
import { createHash } from "node:crypto";
import { SITE } from "./site-environment";
import { ANALYTICS_SOURCES } from "./analytics-events";

/** Server-generated bridge, also rendered by the separate local privacy test harness. */
export function analyticsBridge() {
  const parentOrigin = SITE.origin;
  const pageLocation = `${SITE.origin}/analytics/bridge`;
  const script = `(()=>{"use strict";
const parentOrigin=${JSON.stringify(parentOrigin)}, stream="G-TTRKRJ1HYL";
const sources=${JSON.stringify(ANALYTICS_SOURCES)};
const privacy=()=>navigator.doNotTrack!=="1"&&navigator.doNotTrack!=="yes"&&navigator.globalPrivacyControl!==true;
let initialized=false, count=0;
const location=${JSON.stringify(pageLocation)}, title="Templ conversion events";
function send(){window.dataLayer.push(arguments);}
window.addEventListener("message",(event)=>{
if(event.source!==parent||event.origin!==parentOrigin||!privacy())return;
const value=event.data;
if(!value||typeof value!=="object"||Array.isArray(value))return;
if(value.kind==="templ.analytics.init"){
if(initialized||Object.keys(value).length!==2||typeof value.clientId!=="string"||!/^\\d{1,10}\\.\\d{1,10}$/.test(value.clientId))return;
initialized=true;window.dataLayer=[];window.gtag=send;
send("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"});
send("set","ads_data_redaction",true);send("set","url_passthrough",false);
send("js",new Date());
send("config",stream,{send_page_view:false,client_id:value.clientId,page_location:location,page_title:title,page_referrer:"",allow_google_signals:false,allow_ad_personalization_signals:false});
const tag=document.createElement("script");tag.async=true;tag.referrerPolicy="no-referrer";tag.src="https://www.googletagmanager.com/gtag/js?id="+stream;document.head.appendChild(tag);
return;}
if(!initialized||value.kind!=="templ.analytics.event"||Object.keys(value).length!==3||!Object.hasOwn(sources,value.name)||sources[value.name]!==value.source||count>=100)return;
count++;send("event",value.name,{source:value.source,send_to:stream,page_location:location,page_title:title,page_referrer:""});
});})();`;
  const hash = createHash("sha256").update(script).digest("base64");
  return {
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Templ conversion events</title></head><body><script>${script}</script></body></html>`,
    script,
    csp: `default-src 'none'; script-src 'sha256-${hash}' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://region1.google-analytics.com; img-src https://www.google-analytics.com https://region1.google-analytics.com; base-uri 'none'; form-action 'none'; frame-ancestors ${parentOrigin}; sandbox allow-scripts`,
  };
}
