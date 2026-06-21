// OZ Browser — Publishing compose (composer→main) smoke test.
//
// Run: node tests/publishing-compose.smoketest.js

'use strict'

const assert = require('node:assert')
const C = require('../browser/publishing-compose')

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err.message}`)
  }
}

const IG_ACTION = {
  paramsSchema: {
    type: 'object',
    properties: {
      imagePath: { type: 'string' },
      caption: { type: 'string', maxLength: 2200 },
    },
    required: ['imagePath', 'caption'],
  },
}
const X_ACTION = {
  paramsSchema: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 280 } },
    required: ['text'],
  },
}

ok('mapVariationToParams maps caption/media per network', () => {
  const ig = C.mapVariationToParams('ig_post', { caption: 'hi', mediaPath: '/a.jpg' }, {})
  assert.strictEqual(ig.imagePath, '/a.jpg')
  assert.strictEqual(ig.caption, 'hi')
  const x = C.mapVariationToParams('x_post', { caption: 'tweet' }, {})
  assert.strictEqual(x.text, 'tweet')
  const fb = C.mapVariationToParams('fb_post', { caption: 'status' }, {})
  assert.strictEqual(fb.text, 'status')
})

ok('compose: no variation → same params for all allowed identities', () => {
  const plan = C.buildComposePlan(
    {
      actionId: 'x_post',
      params: { text: 'hello world' },
      identityIds: ['i1', 'i2'],
    },
    {
      action: X_ACTION,
      healthMap: new Map([
        ['i1', 'green'],
        ['i2', 'yellow'],
      ]),
      identities: [
        { id: 'i1', name: 'Pedro' },
        { id: 'i2', name: 'Ctx' },
      ],
    },
  )
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.plan.length, 2)
  assert.strictEqual(plan.plan[0].params.text, 'hello world')
  assert.strictEqual(plan.warned.length, 1) // i2 yellow
  assert.strictEqual(plan.blocked.length, 0)
})

ok('compose: red identity is blocked, not in plan', () => {
  const plan = C.buildComposePlan(
    { actionId: 'x_post', params: { text: 'hi' }, identityIds: ['i1', 'bad'] },
    {
      action: X_ACTION,
      healthMap: new Map([
        ['i1', 'green'],
        ['bad', 'red'],
      ]),
    },
  )
  assert.strictEqual(plan.blocked.length, 1)
  assert.strictEqual(plan.blocked[0].id, 'bad')
  assert.strictEqual(plan.plan.length, 1)
  assert.strictEqual(plan.plan[0].identityId, 'i1')
})

ok('compose: variation yields DIFFERENT captions per identity', () => {
  const plan = C.buildComposePlan(
    {
      actionId: 'ig_post',
      params: { imagePath: '/base.jpg' },
      identityIds: ['i1', 'i2'],
      variation: {
        caption: '{hola|hey|qué tal} {{identity}}',
        hashtags: ['a', 'b', 'c'],
        hashtagCount: 2,
        mediaList: ['/p1.jpg', '/p2.jpg'],
      },
    },
    {
      action: IG_ACTION,
      healthMap: new Map([
        ['i1', 'green'],
        ['i2', 'green'],
      ]),
      identities: [
        { id: 'i1', name: 'Pedro' },
        { id: 'i2', name: 'Contexto' },
      ],
    },
  )
  assert.strictEqual(plan.ok, true)
  assert(plan.plan[0].params.caption.includes('Pedro'))
  assert(plan.plan[1].params.caption.includes('Contexto'))
  // media rotated per index
  assert.strictEqual(plan.plan[0].params.imagePath, '/p1.jpg')
  assert.strictEqual(plan.plan[1].params.imagePath, '/p2.jpg')
  // deterministic
  const plan2 = C.buildComposePlan(
    {
      actionId: 'ig_post',
      params: { imagePath: '/base.jpg' },
      identityIds: ['i1', 'i2'],
      variation: {
        caption: '{hola|hey|qué tal} {{identity}}',
        hashtags: ['a', 'b', 'c'],
        hashtagCount: 2,
        mediaList: ['/p1.jpg', '/p2.jpg'],
      },
    },
    {
      action: IG_ACTION,
      healthMap: new Map([
        ['i1', 'green'],
        ['i2', 'green'],
      ]),
      identities: [
        { id: 'i1', name: 'Pedro' },
        { id: 'i2', name: 'Contexto' },
      ],
    },
  )
  assert.strictEqual(plan.plan[0].params.caption, plan2.plan[0].params.caption)
})

ok('compose: missing required field → ok=false with per-identity errors', () => {
  const plan = C.buildComposePlan(
    { actionId: 'ig_post', params: { caption: 'hi' }, identityIds: ['i1'] }, // no imagePath
    { action: IG_ACTION, healthMap: new Map([['i1', 'green']]) },
  )
  assert.strictEqual(plan.ok, false)
  assert(
    plan.plan[0].errors.some((e) => e.field === 'imagePath' && e.code === 'required'),
  )
})

ok('compose: no targets → ok=false code noTargets', () => {
  const plan = C.buildComposePlan(
    { actionId: 'x_post', params: { text: 'hi' }, identityIds: [] },
    { action: X_ACTION },
  )
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'noTargets')
})

ok('compose: spacingSec → drip options', () => {
  const plan = C.buildComposePlan(
    { actionId: 'x_post', params: { text: 'hi' }, identityIds: ['i1'], spacingSec: 60 },
    { action: X_ACTION, healthMap: new Map([['i1', 'green']]) },
  )
  assert(plan.drip && plan.drip.minDelayMs === 60000)
})

console.log(`\npublishing-compose: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
