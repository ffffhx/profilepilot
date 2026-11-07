import test from 'node:test';
import assert from 'node:assert/strict';
import {genericItems,crosscheck} from '../scripts/verify-xianyu.mjs';

test('live verification compares only common canonical item identities and explicit visible prices',()=>{
 const generic={fast:{candidates:[
  {href:'https://www.goofish.com/item?id=101&tracking=1',label:'DDR5 32GB 内存 ¥399.50'},
  {href:'https://evil.example/item?id=102',label:'unrelated'},
  {href:'https://www.goofish.com/item?id=103',label:'DDR5 32GB 内存'},
 ]}};
 assert.deepEqual(genericItems(generic).map(i=>i.id),['101','103']);
 const rows=crosscheck(generic,{items:[{id:'101',title:'DDR5 32GB 内存',price:399.5},{id:'102',title:'unrelated',price:5},{id:'103',title:'DDR5 32GB 内存',price:32}]});
 assert.deepEqual(rows,[{id:'101',titleMatches:true,priceMatches:true},{id:'103',titleMatches:true,priceMatches:null}]);
 assert.equal(crosscheck(generic,{items:[{id:'101',title:'other model',price:200}]})[0].titleMatches,false);
 assert.equal(crosscheck(generic,{items:[{id:'101',title:'DDR5 32GB 内存',price:200}]})[0].priceMatches,false);
});
