'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),android=path.join(root,'android'),tooling=path.join(android,'.tooling');fs.mkdirSync(tooling,{recursive:true});
const bundled=fs.readdirSync(tooling).find(x=>x.startsWith('jdk-'));
const java=process.env.JAVA_HOME||(bundled?path.join(tooling,bundled,'Contents/Home'):undefined);
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||path.join(tooling,'sdk');
const env={...process.env,...(java?{JAVA_HOME:java}:{}),ANDROID_HOME:sdk,GRADLE_USER_HOME:process.env.GRADLE_USER_HOME||path.join(tooling,'gradle-home')};
const native=process.platform==='win32'?'.bat':'';
function run(bin,args){cp.execFileSync(bin,args,{stdio:'inherit',env,shell:process.platform==='win32'});}
const localGradle=path.join(tooling,'gradle-8.11.1/bin/gradle'+native),gradle=fs.existsSync(localGradle)?localGradle:path.join(android,'gradlew'+native);
const args=['-p',android,':app:assembleRelease','--no-daemon'];const proxy=process.env.HTTPS_PROXY||process.env.https_proxy;if(proxy){const p=new URL(proxy);for(const protocol of ['http','https'])args.push('-D'+protocol+'.proxyHost='+p.hostname,'-D'+protocol+'.proxyPort='+(p.port||'80'));}
run(gradle,args);
const key=process.env.LINX_ANDROID_KEYSTORE||path.join(tooling,'linx-development.jks'),password=process.env.LINX_ANDROID_KEYSTORE_PASSWORD||'android',alias=process.env.LINX_ANDROID_KEY_ALIAS||'linx-development';
if(!fs.existsSync(key))run(java?path.join(java,'bin/keytool'):'keytool',['-genkeypair','-keystore',key,'-storepass',password,'-keypass',password,'-alias',alias,'-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Linx Development, O=Linx, C=CN']);
env.LINX_SIGN_PASSWORD=password;
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});const output=path.join(dist,'Linx-1.1.0-android.apk');const signer=path.join(sdk,'build-tools/35.0.0/apksigner'+native);
run(signer,['sign','--ks',key,'--ks-key-alias',alias,'--ks-pass','env:LINX_SIGN_PASSWORD','--key-pass','env:LINX_SIGN_PASSWORD','--out',output,path.join(android,'app/build/outputs/apk/release/app-release-unsigned.apk')]);
run(signer,['verify','--verbose',output]);fs.copyFileSync(output,path.join(root,'assets/Linx-android.apk'));console.log('Android APK:',output);console.log('已同步到电脑端内置安装包 assets/Linx-android.apk');
