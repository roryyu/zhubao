(() => {
  let currentRoute='', taskId='', panel=null, requestInFlight=false;
  const labels={GLB:'GLB 三维模型',STL:'STL 网格',DXF:'DXF 工程文件',TIF:'16位 TIF',PNG:'16位高度图',EXR:'EXR 高度',JSON:'建模参数 JSON'};
  async function refresh(){
    const route=location.pathname, match=route.match(/^\/workspace\/(2011|2020|2022)$/);
    if(!match){panel?.remove();panel=null;taskId='';currentRoute=route;return;}
    if(route!==currentRoute){panel?.remove();panel=null;taskId='';currentRoute=route;}
    if(requestInFlight)return;requestInFlight=true;
    try{
      const response=await fetch('/v1/api/draw/comfyuiTask/page?drawAppNumber='+match[1]+'&limit=20');
      const packet=await response.json();
      if(location.pathname!==route)return;
      const task=packet.data?.list?.find(t=>t.status===8&&t.artifacts&&Object.keys(t.artifacts).length);
      if(!task||task.id===taskId)return;
      taskId=task.id;panel?.remove();panel=document.createElement('details');panel.className='local-engineering-results';
      panel.style.cssText='position:fixed;right:14px;bottom:28px;z-index:80;max-width:min(440px,calc(100vw - 28px));padding:8px 12px;border:1px solid #6d5c26;border-radius:8px;background:#16150ff2;color:#d8c78f;font:12px/1.7 sans-serif;box-shadow:0 5px 25px #0008';
      const summary=document.createElement('summary');summary.textContent='最近完成的工程文件 · '+task.id.slice(0,8);summary.style.cursor='pointer';panel.append(summary);
      const links=document.createElement('div');links.style.cssText='display:flex;gap:7px;flex-wrap:wrap;margin-top:8px';
      for(const [format,url]of Object.entries(task.artifacts)){
        const target=new URL(url,location.origin);if(target.origin!==location.origin)continue;
        const link=document.createElement('a');link.href=target.href;link.download='';link.textContent=labels[format]||format;link.style.cssText='padding:3px 7px;background:#242116;border-radius:4px;color:#e9cd69;text-decoration:none';links.append(link);
      }
      if(task.artifacts.GLB){const view=document.createElement('a');view.href='/model-viewer?url='+encodeURIComponent(task.artifacts.GLB);view.target='_blank';view.rel='noopener';view.textContent='旋转查看三维模型';view.style.color='#e9cd69';links.append(view);}
      panel.append(links);
      const note=document.createElement('div');note.style.cssText='margin-top:7px;color:#afa791';
      note.textContent=match[1]==='2011'?'参数化概念模型，未知尺寸为估计，未通过打印检验；GLB 用米，STL/DXF 用毫米。':'相对深度浮雕；浅/中/高为 1/3/6 mm。GLB 用米，STL/DXF 用毫米。';panel.append(note);
      document.body.append(panel);
    }catch{}finally{requestInFlight=false;}
  }
  addEventListener('DOMContentLoaded',()=>{refresh();setInterval(refresh,2000);});
})();
