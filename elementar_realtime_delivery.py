from __future__ import annotations


ELEMENTAR_WATCH_RUNTIME = r"""
<script>
(()=>{'use strict';if(window.__superexcelElementarWatchInstalled)return;window.__superexcelElementarWatchInstalled=true;
const nativeFetch=window.fetch.bind(window),watched=new Map();
function isElementar(url){try{const p=new URL(url,location.href).pathname;return p.includes('/public/elementar/')||p.includes('/api/elementar/data/')}catch{return false}}
function versionOf(response){return response.headers.get('ETag')||response.headers.get('X-Elementar-Version')||''}
function remember(url,response){if(!isElementar(url)||!response.ok)return;const absolute=new URL(url,location.href).href;const version=versionOf(response);const current=watched.get(absolute)||{};watched.set(absolute,{etag:version||current.etag||'',checking:false})}
window.fetch=async(input,init)=>{const response=await nativeFetch(input,init);const url=typeof input==='string'?input:input?.url;remember(url,response);return response};
async function check(url,state){if(state.checking||document.hidden||!navigator.onLine)return;state.checking=true;try{const headers={};if(state.etag)headers['If-None-Match']=state.etag;const response=await nativeFetch(url,{headers,cache:'no-store'});if(response.status===304)return;if(!response.ok)return;const next=versionOf(response);if(next&&next===state.etag)return;const data=await response.clone().json().catch(()=>null);state.etag=next||String(Date.now());const event=new CustomEvent('superexcel:elementar-update',{detail:{url,data,version:next},cancelable:true});const shouldReload=window.dispatchEvent(event);if(shouldReload)location.reload()}catch(error){console.debug('Elementar watch adiado.',error)}finally{state.checking=false}}
setInterval(()=>{for(const [url,state]of watched)check(url,state)},1500);
window.addEventListener('focus',()=>{for(const [url,state]of watched)check(url,state)});
})();
</script>
""".strip()


def install(elementar_routes, github_sites) -> None:
    original_serve = elementar_routes.serve

    def serve_without_stale_cache(config):
        response = original_serve(config)
        if hasattr(response, "headers"):
            response.headers["Cache-Control"] = "public, max-age=1, stale-while-revalidate=2, must-revalidate"
        return response

    elementar_routes.serve = serve_without_stale_cache

    original_site_response = github_sites._site_response

    def site_response_with_elementar_watch(file_row, *, sandboxed=False):
        response = original_site_response(file_row, sandboxed=sandboxed)
        if sandboxed or response.status_code != 200:
            return response
        content_type = str(response.content_type or "")
        if "text/html" not in content_type:
            return response
        html = response.get_data(as_text=True)
        if "__superexcelElementarWatchInstalled" in html:
            return response
        marker = "</body>" if "</body>" in html.lower() else "</html>"
        lower = html.lower()
        index = lower.rfind(marker)
        if index >= 0:
            html = f"{html[:index]}{ELEMENTAR_WATCH_RUNTIME}{html[index:]}"
        else:
            html = f"{html}{ELEMENTAR_WATCH_RUNTIME}"
        response.set_data(html)
        response.headers["Cache-Control"] = "public, max-age=5, stale-while-revalidate=15"
        return response

    github_sites._site_response = site_response_with_elementar_watch
