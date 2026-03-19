#!/usr/bin/env node
/**
 * setup-vad.js
 * Copia os arquivos estáticos do vad-web e onnxruntime-web
 * para a pasta /public, que o servidor Node vai servir.
 * Execute: node setup-vad.js
 */

const fs   = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC)) fs.mkdirSync(PUBLIC);

function copyGlob(srcDir, pattern, destDir) {
  if (!fs.existsSync(srcDir)) {
    console.error(`❌  Diretório não encontrado: ${srcDir}`);
    console.error('   Execute npm install primeiro.');
    process.exit(1);
  }
  const files = fs.readdirSync(srcDir).filter(f => {
    if (pattern instanceof RegExp) return pattern.test(f);
    return f.endsWith(pattern);
  });
  if (files.length === 0) {
    console.warn(`⚠️   Nenhum arquivo encontrado em ${srcDir} com padrão ${pattern}`);
    return;
  }
  files.forEach(file => {
    const src  = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    fs.copyFileSync(src, dest);
    console.log(`✓  ${file}`);
  });
}

console.log('\n📦  Copiando arquivos do vad-web...\n');

// 1. Worklet + ONNX model do vad-web
const vadDist = path.join(__dirname, 'node_modules', '@ricky0123', 'vad-web', 'dist');
copyGlob(vadDist, 'vad.worklet.bundle.min.js', PUBLIC);
copyGlob(vadDist, '.onnx', PUBLIC);

// 2. WASM + MJS do onnxruntime-web
const ortDist = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
copyGlob(ortDist, '.wasm', PUBLIC);
copyGlob(ortDist, '.mjs',  PUBLIC);

// 3. Bundle do vad-web
copyGlob(vadDist, /^bundle\.min\.js$/, PUBLIC);

console.log(`\n✅  Arquivos copiados para /public\n`);