const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {loadCli} = require('./cli-test-build.cjs');
const {captchaResponseState, waitForCaptchaResponse} = loadCli('src/main/captcha/wait.ts');
const {runCaptchaCli} = loadCli('src/main/captcha/cli.ts');
const {parseBrowserCliRoute} = loadCli('src/main/browser-cli.ts');

function fixture() {
  const form = {}, widget = {};
  const field = (name, options={}) => {
    const node = {name, value:'', id:'', form, parentElement:widget, ...options};
    node.closest = selector => selector === 'form' ? node.form : node.parentElement === widget ? widget : null;
    node.matches = selector => selector.includes(`[name="${node.name}"]`);
    return node;
  };
  const fields = [field('h-captcha-response'), field('g-recaptcha-response')];
  const root = {matches:()=>false, querySelectorAll:selector=>fields.filter(f=>f.matches(selector))};
  const window = {}, location = {href:'https://example.test/demo'};
  const document = {documentElement:root, querySelectorAll:()=>[root]};
  const context = vm.createContext({window, location, document});
  return {fields, field, form, widget, window, location, document, context, browser:{evaluate:async source=>vm.runInContext(source, context)}};
}

test('wait observes delayed hCaptcha response without exporting its token or claiming server verification', async () => {
  const f=fixture();let clock=0;
  const result=await waitForCaptchaResponse(f.browser,{timeout:1000,now:()=>clock,sleep:async ms=>{clock+=ms;if(clock>=500)f.fields[0].value='private-token'}});
  assert.equal(result.status,'response_present');assert.equal(result.kind,'hcaptcha');assert.equal(result.elapsedMs,500);
  assert.equal(result.verified,false);assert.equal(result.timedOut,false);assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('empty response at deadline is pending, not rejection; navigation and widget replacement stop polling', async () => {
  for (const mode of ['pending','page_changed','challenge_changed']) {
    const f=fixture();let clock=0;
    const result=await waitForCaptchaResponse(f.browser,{timeout:1000,now:()=>clock,sleep:async ms=>{clock+=ms;if(mode==='page_changed')f.location.href+='?new';if(mode==='challenge_changed')f.fields[0]={...f.fields[0]}}});
    assert.equal(result.status,mode);assert.equal(result.timedOut,mode==='pending');assert.equal(result.verified,false);
  }
});

test('multiple widgets require selection and a new document cannot reuse a previous wait', async () => {
  const f=fixture();f.fields.push({...f.fields[0]});
  const result=await waitForCaptchaResponse(f.browser,{timeout:1000});assert.equal(result.status,'ambiguous');
  const source=`(${captchaResponseState.toString()})(${JSON.stringify({id:'old',initial:false})})`;
  delete f.window.__profilepilotCaptchaWaitV1;assert.equal((await f.browser.evaluate(source)).status,'page_changed');
});

test('missing fields remain unconfirmed and field removal ends an existing wait', async () => {
  const f=fixture();let clock=0;
  f.fields.length=0;
  const result=await waitForCaptchaResponse(f.browser,{timeout:1000,now:()=>clock,sleep:async ms=>clock+=ms});
  assert.equal(result.status,'not_detected');assert.equal(result.timedOut,true);
  const g=fixture();clock=0;
  const changed=await waitForCaptchaResponse(g.browser,{timeout:1000,now:()=>clock,sleep:async ms=>{clock+=ms;g.fields.length=0}});
  assert.equal(changed.status,'challenge_changed');assert.equal(changed.timedOut,false);
});

test('MTCaptcha response inserted after solving is observed without reading a provider API or exporting its value', async () => {
  const f=fixture();f.fields.length=0;let clock=0;
  Object.defineProperty(f.window,'mtcaptcha',{get:()=>assert.fail('must not invoke the provider API')});
  const result=await waitForCaptchaResponse(f.browser,{timeout:1000,now:()=>clock,sleep:async ms=>{
    clock+=ms;
    f.fields.push(f.field('mtcaptcha-verifiedtoken',{value:'private-mtcaptcha-token'}));
  }});
  assert.equal(result.status,'response_present');assert.equal(result.kind,'mtcaptcha');assert.equal(result.elapsedMs,250);
  assert.equal(result.verified,false);assert.ok(!JSON.stringify(result).includes('private-mtcaptcha-token'));
});

test('independent reCAPTCHA is not hidden by an hCaptcha in the same form or outside any form', async () => {
  for(const form of [{},null]) {
    const f=fixture();for(const field of f.fields)field.form=form;
    f.fields.push(f.field('g-recaptcha-response',{form,parentElement:{},value:'other-widget-token'}));
    const result=await waitForCaptchaResponse(f.browser,{timeout:1000});
    assert.equal(result.status,'ambiguous');assert.equal(result.fields,2);assert.equal(result.verified,false);
    assert.ok(!JSON.stringify(result).includes('other-widget-token'));
  }
});

test('hCaptcha compatibility fields pair by widget container or matching widget IDs, not a shared generic container', async () => {
  const f=fixture();const container={};
  for(const field of f.fields)field.parentElement=container;
  assert.equal((await waitForCaptchaResponse(f.browser,{timeout:1000})).status,'ambiguous');
  f.fields[0].id='h-captcha-response-widget1';f.fields[1].id='g-recaptcha-response-widget1';
  f.fields[0].value='private-token';
  assert.equal((await waitForCaptchaResponse(f.browser,{timeout:1000})).status,'response_present');
});

test('reusing a response element for another widget ends the wait before accepting its value', async () => {
  for(const change of [field=>field.name='mtcaptcha-verifiedtoken',field=>field.id='different',field=>field.parentElement={},field=>field.form={}]) {
    const f=fixture();f.fields.splice(1);let clock=0;
    const result=await waitForCaptchaResponse(f.browser,{timeout:1000,now:()=>clock,sleep:async ms=>{
      clock+=ms;change(f.fields[0]);f.fields[0].value='new-widget-token';
    }});
    assert.equal(result.status,'challenge_changed');assert.equal(result.timedOut,false);assert.equal(result.verified,false);
  }
});

test('selector can disambiguate a response field, while an invalid selector fails without polling', async () => {
  const f=fixture();const selected=f.field('mtcaptcha-verifiedtoken',{value:'private-token'});
  f.document.querySelectorAll=selector=>{assert.equal(selector,'#selected');return [selected]};
  const result=await waitForCaptchaResponse(f.browser,{timeout:1000,selector:'#selected'});
  assert.equal(result.status,'response_present');assert.equal(result.kind,'mtcaptcha');
  f.document.querySelectorAll=()=>{throw new Error('Invalid selector')};
  await assert.rejects(waitForCaptchaResponse(f.browser,{timeout:1000,selector:'[',sleep:()=>assert.fail('must stop')}),{code:'CAPTCHA_INVALID_ARGUMENTS'});
});

test('pre-existing responses and whitespace never imply this attempt succeeded', async () => {
  const f=fixture();f.fields[0].value='old-token';
  const existing=await waitForCaptchaResponse(f.browser,{timeout:1000,sleep:()=>assert.fail('must not poll')});
  assert.equal(existing.status,'response_present');assert.equal(existing.verified,false);assert.match(existing.note,/等待前/);
  f.fields[0].value=' \n\t';let clock=0;
  const pending=await waitForCaptchaResponse(f.browser,{timeout:1000,now:()=>clock,sleep:async ms=>clock+=ms});
  assert.equal(pending.status,'pending');assert.equal(pending.timedOut,true);assert.equal(pending.verified,false);
});

test('unexpected evaluation properties cannot escape in the wait result', async () => {
  const result=await waitForCaptchaResponse({evaluate:async()=>({status:'response_present',kind:'mtcaptcha',token:'private-token',text:'private page text',verified:true})},{timeout:1000});
  assert.equal(result.verified,false);assert.equal(result.kind,'mtcaptcha');assert.ok(!('token' in result));assert.ok(!('text' in result));
});

test('wait CLI makes no provider call and stops on ownership failure', async () => {
  const route=parseBrowserCliRoute(['--session','test','--cdp','9224','captcha','wait','--timeout','1000']);
  let stdout='',stderr='',clock=0,reads=0;
  const io={stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}};
  const runtime={browser:{evaluate:async()=>++reads===1?{status:'pending'}:{status:'response_present'}},provider:{result:()=>assert.fail('must not call solver')},now:()=>clock,sleep:async ms=>clock+=ms};
  assert.equal(await runCaptchaCli(route,io,{PROFILEPILOT_CAPTCHA_PROVIDER:'codex'},runtime),0);
  assert.equal(JSON.parse(stdout).result.status,'response_present');assert.equal(reads,2);
  runtime.browser.evaluate=async()=>{throw Object.assign(new Error('ownership changed'),{code:'CAPTCHA_CONTROL_CHANGED'})};
  assert.equal(await runCaptchaCli(route,io,{},runtime),75);assert.match(stderr,/CAPTCHA_CONTROL_CHANGED/);
});
