// SVG → 여러 크기 PNG 렌더 후 멀티사이즈 ICO 생성.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const _p2i = require('png-to-ico');
const pngToIco = _p2i.default || _p2i;

const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf-8');
function renderPng(size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' });
  return r.render().asPng();
}

// 일반용 큰 PNG (linux/표시용)
fs.writeFileSync(path.join(__dirname, 'icon.png'), renderPng(1024));

// ICO 에 담을 표준 크기들
const sizes = [256, 128, 64, 48, 32, 24, 16];
const buffers = sizes.map(renderPng);

pngToIco(buffers).then((ico) => {
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
  console.log('icon.ico written:', ico.length, 'bytes; sizes =', sizes.join(','));
}).catch((e) => { console.error('ICO 생성 실패:', e); process.exit(1); });
