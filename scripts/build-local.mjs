import { cp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'captured'), dist, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: source => !source.endsWith('.partial') });
const changes = [];
async function patch(path, transform, reason) {
  const full = resolve(dist, path), original = await readFile(full, 'utf8'), modified = transform(original);
  if (modified !== original) {
    await writeFile(full, modified);
    const prior=changes.find(change=>change.path===path);
    if(prior){prior.reason+=' '+reason;prior.localSha256=createHash('sha256').update(modified).digest('hex');}
    else changes.push({ path, reason, originalSha256: createHash('sha256').update(original).digest('hex'), localSha256: createHash('sha256').update(modified).digest('hex') });
  }
}
const uiAssets = JSON.parse(await readFile(resolve(root, 'evidence/ui-config-assets.json'), 'utf8'));
await patch('assets/main-f2a9c0e4.js', s => {
  let text = s.replaceAll('https://cjzbai.com/v1', '/v1').replace('XM="https://cjzbai-1389715364.cos.ap-chengdu.myqcloud.com"', 'XM=location.origin').replaceAll('https://via.placeholder.com/400x400/1a1a1a/666666?text=Image+Not+Found', '/local/image-not-found.svg').replaceAll('剩余算力:', '演示算力:').replaceAll('优惠期', '原站参考');
  text = text.replaceAll('创觉', '无觉').replaceAll('fillText("创"', 'fillText("无"').replaceAll('text-3xl"},"创")', 'text-3xl"},"无")').replaceAll('>创</span>', '>无</span>');
  for (const asset of uiAssets.files) text = text.replaceAll(asset.source, '/' + asset.path);
  text=text.replace('"/src/views/drawApps/2020/index.vue":()=>qt(()=>import("./index-1977b872.js"),[])','"/src/views/drawApps/2020/index.vue":()=>qt(()=>import("./index-1977b872.js"),["assets/ReliefLive-97698c30.css"])');
  return text;
}, 'Route API and relative media to this local origin; localize observed static and fallback images; rebrand 创觉/创 marks to 无觉/无. No production proxy.');
for (const file of await readdir(resolve(dist, 'assets'))) {
  if (file.endsWith('.js') && file !== 'main-f2a9c0e4.js') await patch('assets/' + file, text => text.replaceAll('优惠期', '原站参考').replaceAll('3D打印标准格式，适合直接打印使用','网格交换格式，打印前须检查封闭性与壁厚').replaceAll('创觉', '无觉'), 'Label original-site pricing as reference, not local model billing; rebrand 创觉 to 无觉.');
}
await patch('assets/ReliefLive-b9170ac9.js', text => {
  const lengthStart=text.indexOf('e("section",Qe,');
  const lengthEnd=text.indexOf('e("section",tt,',lengthStart);
  if(lengthStart<0||lengthEnd<0)throw new Error('Relief form changed: physical size control not found');
  const sizeControl=text.slice(lengthStart,lengthEnd);
  text=text.replace('l.feature.id!=="vectorline"?(d(),m("section",Ae,[','l.feature.id!=="vectorline"?(d(),m("section",Ae,['+sizeControl);
  text=text.replace('formats:["VSM","TIF","EXR","PNG"]','formats:["TIF","EXR","PNG","STL","GLB"]')
    .replace('formats:["VS3D","JDP","DXF","AI"],defaultFormat:"VS3D"','formats:["DXF","STL","GLB","TIF"],defaultFormat:"DXF"')
    .replace('const a={feature_id:l.id,formats:[s.format]}','const a={feature_id:l.id,formats:[s.format],model_length_mm:Number(s.modelLength)}')
    .replace('imageUrl:r,format:g,','imageUrl:r,format:g,modelLengthMm:s.model_length_mm,')
    .replace('将参考图片转换为浮雕工程文件','神经相对深度生成高度图与封闭浮雕网格')
    .replace('浮雕高度与矢量线条，一次生成一种格式','浮雕高度与原图线条，支持标准 DXF 和网格导出')
    .replace('只包含二维矢量线，不含三维浮雕高度。','DXF 包含三维浮雕网格与沿高度分布的原图线条，单位为毫米。')
    .replace('此图仅用于验收页面流程，不代表生成质量或实际工程文件。','浮雕来自单图相对深度估计。尺寸按画布长边设置，浅/中/高分别为 1/3/6 mm；不代表物体真实测量值。')
    .replaceAll(' 算力/次','（原站参考价）').replaceAll('"算力/次"','"（原站参考）"')
    .replace('每次生成一种格式；换格式重新生成属于新任务。','同时保存标准高度图与网格，可在工程文件栏下载其他格式。')
    .replace('每次生成一种格式，请确认后提交','本地浮雕使用 CPU 计算，不扣除页面演示算力')
    .replace('保存浮雕结果；尺寸与处理参数以后端实际配置为准。','浅/中/高起伏为 1/3/6 mm，底板厚 0.6 mm。')
    .replace('c(p.value.platformCost??"—")+" 算力 · "','"本地计算 · "');
  return text;
},'Enable standard engineering formats and physical long-edge controls; remove unavailable proprietary format promises.');
await patch('assets/index-1977b872.js',()=> 'import{R as Relief}from"./ReliefLive-b9170ac9.js";import{h as openBlock,X as createBlock}from"./main-f2a9c0e4.js";export default{__name:"LocalRelief",setup(){return()=> (openBlock(),createBlock(Relief,{"app-number":2020}))}};\n','Use the shared engineering workbench for neural relief and standard-format downloads.');
await patch('assets/index-2211217c.js',text=>text
  .replace('setup(P){const A=Ae()', 'setup(P){const localModel3D=u({mode:"parametric-csg"});fetch("/__local/health").then(r=>r.json()).then(r=>{if(r.models?.model3d){localModel3D.value=r.models.model3d;if(localModel3D.value.mode!=="parametric-csg"&&i.value.faceCount===20000)i.value.faceCount=100000}}).catch(()=>{});const A=Ae()')
  .replace('H=N(()=>J.value?ze(O.value,i.value.geometryQuality):be)','H=N(()=>localModel3D.value.mode==="parametric-csg"?[{label:"参数化实体建模（概念模型）",value:20000}]:[{label:"神经重建（专用3D模型）",value:100000}])')
  .replace('i=u({faceCount:15e5,','i=u({faceCount:20000,')
  .replace('a("div",Ct,[','a("p",{style:{fontSize:"12px",lineHeight:"1.7",color:"#aaa394"}},localModel3D.value.mode==="parametric-csg"?"千问生成参数化实体模型（车削/拉伸/扫掠/对称阵列），并经三视角渲染自评修正。复杂有机造型仍为近似，未知尺寸为估计值。":"当前使用专用3D生成服务，结构与贴图由模型生成；仍须检查实际结果。"),a("div",Ct,[')
  .replace('Ct={class:"grid grid-cols-4 panel-gap-sm"}','Ct={class:"grid grid-cols-1 panel-gap-sm"}')
  .replace('J.value?(d(),v("div",jt,','!1?(d(),v("div",jt,')
  .replace('"模型面数"','"建模方式"').replace('"几何+纹理"','"彩色材质"'),
  'Expose full-width parametric mesh mode instead of promising unsupported cloud face-count and texture quality tiers.');
await patch('index.html', s => s.replace(/<script[^>]*id="LA_COLLECT"[^>]*><\/script>/, '').replace(/<script>LA\.init\([\s\S]*?<\/script>/, '').replace('<head>', '<head>\n<script src="/local/bootstrap.js"></script>\n<script defer src="/local/geometry-artifacts.js"></script>').replace('<link rel="stylesheet" href="/assets/index-65e4d7ab.css">', '<link rel="stylesheet" href="/assets/index-65e4d7ab.css">\n<link rel="stylesheet" href="/local/luxury-theme.css">').replace('<link rel="icon" href="/favicon.ico">', '<link rel="icon" type="image/svg+xml" href="/local/favicon.svg">\n<link rel="icon" href="/favicon.ico">').replaceAll('创觉', '无觉'), 'Remove external analytics, initialize a synthetic account, expose real engineering downloads, apply the luxury black-gold theme overlay and rebrand 创觉 to 无觉.');
await mkdir(resolve(dist, 'local'), { recursive: true });
await cp(resolve(root,'src/geometry-artifacts.js'),resolve(dist,'local/geometry-artifacts.js'));
await cp(resolve(root,'src/luxury-theme.css'),resolve(dist,'local/luxury-theme.css'));
await cp(resolve(root,'src/brand-mark.svg'),resolve(dist,'local/favicon.svg'));
await cp(resolve(root,'src/favicon.ico'),resolve(dist,'favicon.ico'));
await writeFile(resolve(dist, 'local/bootstrap.js'), `(() => {
  const user = {id:'100001', nickName:'本地演示', msgCount:50, avatar:new URL('/local/avatar.svg', location.origin).href, phone:'', vipLevel:0, isVip:0, money:0};
  localStorage.setItem('token', 'local-demo-not-a-production-credential');
  localStorage.setItem('userInfo', JSON.stringify(user));
  localStorage.setItem('baseConfig', '[]');
  addEventListener('DOMContentLoaded', () => {
    const badge = document.createElement('div');
    badge.textContent = '本地设计 · 页面算力为演示值，实际调用按模型服务商计费';
    badge.style.cssText = 'position:fixed;bottom:0;left:0;z-index:9999;padding:3px 10px;background:#19170e;color:#c8bc8c;font:11px/1.6 sans-serif;pointer-events:none;border-top:1px solid #504726;max-width:100vw';
    document.body.appendChild(badge);
  });
})();\n`);
await writeFile(resolve(dist, 'local/avatar.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#171717"/><text x="40" y="52" text-anchor="middle" fill="#d4af37" font-size="36" font-family="sans-serif">无</text></svg>');
await writeFile(resolve(dist, 'local/image-not-found.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#1a1a1a"/><text x="200" y="205" text-anchor="middle" fill="#666666" font-family="Arial,sans-serif" font-size="16">Image Not Found</text></svg>');
await writeFile(resolve(root, 'evidence/local-patches.json'), JSON.stringify({ builtAt: new Date().toISOString(), changes, note: 'captured/ remains byte-identical to public downloads. Synthetic account and public read snapshots; local model endpoints may be configured separately.' }, null, 2));
console.log(`Prepared dist with ${changes.length} documented adaptation patches.`);
