const fs = require('node:fs');
const path = require('node:path');
const license = '<license id="android-sdk-license">Android test license &amp; conditions.</license>';
const toolArchive = os => `<archive><host-os>${os}</host-os><complete><size>123</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>commandlinetools-${os}.zip</url></complete></archive>`;
const baseXml = `<sdk-repository>${license}<remotePackage path="cmdline-tools;19.0"><uses-license ref="android-sdk-license"/><archives>${['windows','macosx','linux'].map(toolArchive).join('')}</archives></remotePackage><remotePackage path="emulator"><uses-license ref="android-sdk-license"/></remotePackage><remotePackage path="platform-tools"><uses-license ref="android-sdk-license"/></remotePackage></sdk-repository>`;
const imageXml = `<sdk-sys-img>${license}${['x86_64','arm64-v8a'].map(abi=>`<remotePackage path="system-images;android-35;google_apis;${abi}"><type-details><api-level>35</api-level></type-details><uses-license ref="android-sdk-license"/><channelRef ref="channel-0"/><archives><archive><complete><size>1024</size></complete></archive></archives></remotePackage>`).join('')}</sdk-sys-img>`;
const write = (file, value = 'fixture') => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,value); };
exports.baseXml = baseXml; exports.imageXml = imageXml; exports.write = write;
exports.createAndroidFixture = function(AndroidSetup, root, {platform='win32',arch='x64',delay=10}={}) {
  const sdkRoot = path.join(root,'Android SDK 空间'), avdHome = path.join(root,'AVDs');
  const binary = name => name+(platform==='win32'?'.exe':'');
  const calls = [], avds = [], behavior = {failImage:false,hang:false,failCatalog:false};
  const runtime = new AndroidSetup({sdkRoot,avdHome,platform,arch,env:{JAVA_HOME:path.join(root,'missing-java')},
    fetch: async url => {
      if (behavior.failCatalog) throw new Error('fixture offline');
      if (String(url).includes('adoptium.net')) return new Response(JSON.stringify([{binary:{package:{link:'https://github.com/adoptium/temurin21-binaries/releases/download/test/java.zip',checksum:'b'.repeat(64),size:123}}}]));
      return new Response(String(url).includes('sys-img')?imageXml:baseXml);
    },
    download: async (_archive,file,_fetch,signal,progress) => { signal.throwIfAborted();write(file);progress(50); },
    extract: async (file,dest,signal) => { signal.throwIfAborted(); if(file.endsWith('tools.zip')) {for(const tool of ['sdkmanager','avdmanager'])write(path.join(dest,'cmdline-tools','lib',tool+'-classpath.jar'));write(path.join(dest,'cmdline-tools','source.properties'),'Pkg.Revision=19.0');} else write(path.join(dest,'jdk-21',...(platform==='darwin'?['Contents','Home']:[]),'bin',binary('java'))); },
    run: async command => {
      if(command.args[0]==='-version') { if(fs.existsSync(command.file)) return 'openjdk version "21.0.8"'; throw new Error('No Java'); }
      calls.push(command);
      if(behavior.hang) await new Promise((resolve,reject)=>{command.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
      await new Promise(resolve=>setTimeout(resolve,delay));command.signal.throwIfAborted();command.output?.('50%');
      if(command.args.includes('--install')) {
        if(behavior.failImage && command.args.some(x=>x.startsWith('system-images;'))) {behavior.failImage=false;throw new Error('fixture download interrupted');}
        for(const pkg of command.args.slice(command.args.indexOf('--install')+1)) {
          if(pkg==='platform-tools')write(path.join(sdkRoot,pkg,binary('adb')));
          if(pkg==='emulator')for(const file of [binary('emulator'),'package.xml','lib/hardware-properties.ini'])write(path.join(sdkRoot,pkg,file));
          if(pkg.startsWith('system-images;')) for(const file of ['source.properties','system.img','userdata.img'])write(path.join(sdkRoot,...pkg.split(';'),file));
        }
      } else if(command.args.includes('avd')) {
        if(!fs.existsSync(command.env.ANDROID_AVD_HOME))throw new Error('AVD home must exist before invoking avdmanager');
        const name = command.args[command.args.indexOf('--name')+1];
        if(fs.existsSync(path.join(avdHome,name+'.ini')))throw new Error('existing');
        write(path.join(avdHome,name+'.ini'),'path='+path.join(avdHome,name+'.avd'));
        write(path.join(avdHome,name+'.avd','config.ini'),'hw.ramSize=1536\ndisk.dataPartition.size=2G\nhw.device.name=pixel_6\n');avds.push(name);
      }
      return '100% Done';
    }
  });
  return {runtime,sdkRoot,avdHome,calls,avds,behavior};
};
exports.waitAndroidJob = async runtime => {
  for(let i=0;i<500;i++) {const state=await runtime.snapshot();if(state.job?.status!=='running')return state;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Android fixture job timed out');
};
