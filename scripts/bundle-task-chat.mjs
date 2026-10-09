import {build} from 'esbuild';
import {createRequire} from 'node:module';
const codeRequire = createRequire(import.meta.resolve('@streamdown/code'));
// Streamdown's stock code plugin otherwise pulls every Shiki grammar into this
// offline Electron bundle. The web bundle covers common code/markup languages;
// other languages still render as ordinary code blocks with copy support.
await build({entryPoints:['src/renderer/tasks.ts'],bundle:true,minify:true,outfile:'dist/renderer/tasks.js',platform:'browser',format:'iife',target:'es2022',logLevel:'warning',
  plugins:[{name:'chat-code-languages',setup(build) {build.onResolve({filter:/^shiki$/},()=>({path:codeRequire.resolve('shiki/bundle/web')}));}}]
});
