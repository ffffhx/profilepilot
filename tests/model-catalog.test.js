const test = require('node:test');
const assert = require('node:assert/strict');
const { listServiceModels } = require('../dist/main/tasks/model-catalog');

test('model catalog uses the configured origin, provider auth and a normalized models path', async () => {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => { requests.push({url: String(url), ...options}); return {ok:true,json:async()=>({data:[{id:'b'},{id:'a'},{id:'a'},{id:4}]})}; };
  try {
    assert.deepEqual(await listServiceModels({baseUrl:'https://api.anthropic.com/v1'},'fixture'),['a','b']);
    assert.equal(requests[0].url,'https://api.anthropic.com/v1/models');
    assert.equal(requests[0].headers['x-api-key'],'fixture');
    assert.equal(requests[0].redirect,'error');
    await listServiceModels({baseUrl:'https://api.moonshot.cn/anthropic'},'fixture');
    assert.equal(requests[1].url,'https://api.moonshot.cn/v1/models');
    assert.equal(requests[1].headers.Authorization,'Bearer fixture');
    await listServiceModels({baseUrl:'https://gateway.example/prefix/v1/',authMode:'bearer'},'fixture');
    assert.equal(requests[2].url,'https://gateway.example/prefix/v1/models');
    for (const baseUrl of ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com/anthropic/v1/']) {
      await listServiceModels({baseUrl,authMode:'apiKey'},'fixture');
      assert.equal(requests.at(-1).url,'https://api.deepseek.com/v1/models');
      assert.equal(requests.at(-1).headers.Authorization,'Bearer fixture');
      assert.equal(requests.at(-1).headers['x-api-key'],undefined);
    }
    await assert.rejects(listServiceModels({baseUrl:'http://remote.example'},'fixture'),/地址无效/);
    await assert.rejects(listServiceModels({baseUrl:'https://api.anthropic.com'},''),/密钥/);
    global.fetch = async()=>({ok:false,status:404});
    await assert.rejects(listServiceModels({baseUrl:'https://gateway.example'},'fixture'),/404/);
    global.fetch = async()=>({ok:true,json:async()=>({data:[]})});
    await assert.rejects(listServiceModels({baseUrl:'https://gateway.example'},'fixture'),/未返回模型列表/);
  } finally { global.fetch = original; }
});
