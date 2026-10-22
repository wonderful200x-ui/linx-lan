'use strict';
// SDK-only build, useful when Gradle's Maven repositories cannot be reached.
// Uses exactly the same sources and Android manifest as the Gradle project.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),android=path.join(root,'android'),tooling=path.join(android,'.tooling');
const sdk=process.env.ANDROID_HOME||path.join(tooling,'sdk');
const java=process.env.JAVA_HOME||fs.readdirSync(tooling).filter(x=>x.startsWith('jdk-')).map(x=>path.join(tooling,x,'Contents/Home'))[0];
const tools=path.join(sdk,'build-tools/35.0.0'),androidJar=path.join(sdk,'platforms/android-35/android.jar');
const out=path.join(android,'app/build/sdk-local'),classes=path.join(out,'classes'),dex=path.join(out,'dex'),generated=path.join(out,'generated');
function run(bin,args){cp.execFileSync(bin,args,{stdio:'inherit',env:{...process.env,JAVA_HOME:java}});}
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
fs.rmSync(out,{recursive:true,force:true});for(const dir of [out,classes,dex,generated])fs.mkdirSync(dir,{recursive:true});
run(path.join(tools,'aapt2'),['compile','--dir',path.join(android,'app/src/main/res'),'-o',path.join(out,'resources.zip')]);
const manifest=path.join(out,'AndroidManifest.xml');fs.writeFileSync(manifest,fs.readFileSync(path.join(android,'app/src/main/AndroidManifest.xml'),'utf8').replace('<manifest ', '<manifest package="local.linx.android" '));
const unsigned=path.join(out,'unsigned.apk');run(path.join(tools,'aapt2'),['link','--auto-add-overlay','-o',unsigned,'--manifest',manifest,'-I',androidJar,'--java',generated,'-R',path.join(out,'resources.zip'),'--min-sdk-version','26','--target-sdk-version','35','--version-code','3','--version-name',require('../package.json').version]);
run(path.join(java,'bin/javac'),['-encoding','UTF-8','--release','8','-cp',androidJar,'-d',classes,...walk(path.join(android,'app/src/main/java')).filter(f=>f.endsWith('.java')),...walk(generated).filter(f=>f.endsWith('.java'))]);
run(path.join(java,'bin/jar'),['cf',path.join(out,'classes.jar'),'-C',classes,'.']);
run(path.join(tools,'d8'),['--min-api','26','--lib',androidJar,'--output',dex,path.join(out,'classes.jar')]);
run('/usr/bin/zip',['-j',unsigned,...walk(dex).filter(f=>f.endsWith('.dex'))]);
const aligned=path.join(out,'aligned.apk');run(path.join(tools,'zipalign'),['-f','4',unsigned,aligned]);
const key=path.join(tooling,'linx-development.jks');if(!fs.existsSync(key))run(path.join(java,'bin/keytool'),['-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','linx-development','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Linx Development, O=Linx, C=CN']);
fs.mkdirSync(path.join(root,'dist'),{recursive:true});const apk=path.join(root,'dist/FlyingMouse-'+require('../package.json').version+'-android.apk');
run(path.join(tools,'apksigner'),['sign','--ks',key,'--ks-pass','pass:android','--key-pass','pass:android','--out',apk,aligned]);
run(path.join(tools,'apksigner'),['verify','--verbose',apk]);console.log('APK:',apk);
