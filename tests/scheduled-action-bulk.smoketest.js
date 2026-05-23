// OZ Browser — scheduled-action-bulk handler smoke test (v2 Etapa 2.1).
//
// Verifies the bulk handler factory + the registration helper:
//   - Validates params.spec shape (actionId, identityIds, params, options).
//   - Skips on locked vault.
//   - Delegates to bulkRunner.run() and surfaces the runId.
//   - Surfaces typos at fire time via registry probe (UNKNOWN_BULK_ACTION).
//   - registerScheduledActionHandlers wires 'bulk' when deps.bulkRunner present.

'use strict'

const {
  createBulkHandler,
  ScheduledBulkError,
  ACTION_BULK,
} = require('../browser/scheduled-action-bulk')
const {
  registerScheduledActionHandlers,
  ACTION_BULK: ACTION_BULK_REEXPORT,
} = require('../browser/scheduled-action-handlers')

let passed = 0
let failed = 0

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

function section(name) {
  console.log(`\n— ${name} —`)
}

function makeRunner() {
  const calls = []
  return {
    calls,
    run: async (spec) => {
      calls.push(spec)
      return 'run-id-fake'
    },
  }
}

function makeRegistry(known = ['ig_like', 'x_post']) {
  return {
    get: (id) => (known.includes(id) ? { id } : null),
  }
}

async function expectThrow(fn, code) {
  try {
    await fn()
    return null
  } catch (err) {
    return err && err.code === code ? err : err
  }
}

async function main() {
  section('factory rejects missing deps')
  {
    try {
      createBulkHandler({})
      ok('throws when bulkRunner missing', false)
    } catch (err) {
      ok(
        'throws when bulkRunner missing',
        err instanceof ScheduledBulkError && err.code === 'BAD_DEP',
      )
    }
  }

  section('happy path: returns ok + runId')
  {
    const runner = makeRunner()
    const h = createBulkHandler({ bulkRunner: runner })
    const out = await h({
      spec: {
        actionId: 'ig_like',
        identityIds: ['id-1', 'id-2'],
        params: { postUrl: 'https://instagram.com/p/abc' },
        options: { minDelayMs: 10, maxDelayMs: 30 },
      },
    })
    ok('returns ok:true', out && out.ok === true, JSON.stringify(out))
    ok('returns runId from runner', out.runId === 'run-id-fake')
    ok('runner called once', runner.calls.length === 1)
    ok('runner got actionId', runner.calls[0].actionId === 'ig_like')
    ok(
      'runner got cloned identityIds',
      Array.isArray(runner.calls[0].identityIds) &&
        runner.calls[0].identityIds.length === 2 &&
        runner.calls[0].identityIds !== undefined,
    )
    ok(
      'runner got params copy',
      runner.calls[0].params.postUrl === 'https://instagram.com/p/abc',
    )
    ok(
      'runner got options copy',
      runner.calls[0].options.minDelayMs === 10 &&
        runner.calls[0].options.maxDelayMs === 30,
    )
  }

  section('params validation')
  {
    const h = createBulkHandler({ bulkRunner: makeRunner() })

    const noSpec = await expectThrow(() => h({}), 'BAD_PARAMS')
    ok('no spec → BAD_PARAMS', noSpec && noSpec.code === 'BAD_PARAMS')

    const noActionId = await expectThrow(
      () => h({ spec: { identityIds: ['x'] } }),
      'BAD_ACTION_ID',
    )
    ok('no actionId → BAD_ACTION_ID', noActionId && noActionId.code === 'BAD_ACTION_ID')

    const noIds = await expectThrow(
      () => h({ spec: { actionId: 'echo', identityIds: [] } }),
      'BAD_IDENTITY_IDS',
    )
    ok('empty identityIds → BAD_IDENTITY_IDS', noIds && noIds.code === 'BAD_IDENTITY_IDS')

    const tooMany = await expectThrow(
      () =>
        h({
          spec: {
            actionId: 'echo',
            identityIds: new Array(201).fill('x'),
          },
        }),
      'TOO_MANY_IDENTITIES',
    )
    ok(
      '201 identities → TOO_MANY_IDENTITIES',
      tooMany && tooMany.code === 'TOO_MANY_IDENTITIES',
    )

    const badId = await expectThrow(
      () => h({ spec: { actionId: 'echo', identityIds: ['ok', 42] } }),
      'BAD_IDENTITY_ID',
    )
    ok('non-string id → BAD_IDENTITY_ID', badId && badId.code === 'BAD_IDENTITY_ID')

    const badSpecParams = await expectThrow(
      () =>
        h({
          spec: { actionId: 'echo', identityIds: ['x'], params: 'string' },
        }),
      'BAD_SPEC_PARAMS',
    )
    ok(
      'non-object spec.params → BAD_SPEC_PARAMS',
      badSpecParams && badSpecParams.code === 'BAD_SPEC_PARAMS',
    )

    const badSpecOpts = await expectThrow(
      () =>
        h({
          spec: { actionId: 'echo', identityIds: ['x'], options: [1, 2] },
        }),
      'BAD_SPEC_OPTIONS',
    )
    ok(
      'array spec.options → BAD_SPEC_OPTIONS',
      badSpecOpts && badSpecOpts.code === 'BAD_SPEC_OPTIONS',
    )
  }

  section('registry probe — unknown actionId')
  {
    const runner = makeRunner()
    const h = createBulkHandler({
      bulkRunner: runner,
      bulkActionsRegistry: makeRegistry(['ig_like']),
    })
    const out = await expectThrow(
      () =>
        h({
          spec: { actionId: 'unknown_action_xyz', identityIds: ['x'] },
        }),
      'UNKNOWN_BULK_ACTION',
    )
    ok(
      'unknown actionId → UNKNOWN_BULK_ACTION',
      out && out.code === 'UNKNOWN_BULK_ACTION',
    )
    ok('runner NOT called when actionId unknown', runner.calls.length === 0)
  }

  section('locked vault → skipped:vault-locked')
  {
    const runner = makeRunner()
    const lockedVault = { isLocked: () => true }
    const h = createBulkHandler({ bulkRunner: runner, vault: lockedVault })
    const out = await h({ spec: { actionId: 'echo', identityIds: ['x'] } })
    ok(
      'returns skipped object',
      out && out.skipped === true && out.reason === 'vault-locked',
      JSON.stringify(out),
    )
    ok('runner NOT called when vault locked', runner.calls.length === 0)
  }

  section('unlocked vault → handler fires')
  {
    const runner = makeRunner()
    const unlockedVault = { isLocked: () => false }
    const h = createBulkHandler({ bulkRunner: runner, vault: unlockedVault })
    const out = await h({ spec: { actionId: 'echo', identityIds: ['x'] } })
    ok('returns ok:true with unlocked vault', out && out.ok === true)
    ok('runner called', runner.calls.length === 1)
  }

  section('ACTION_BULK re-exported from action-handlers')
  {
    ok('ACTION_BULK === "bulk"', ACTION_BULK === 'bulk')
    ok('re-export matches', ACTION_BULK_REEXPORT === ACTION_BULK)
  }

  section('registerScheduledActionHandlers wires bulk')
  {
    const captured = {}
    const fakeScheduled = {
      setHandler: (type, fn) => {
        captured[type] = fn
      },
    }
    const runner = makeRunner()
    const registered = registerScheduledActionHandlers(fakeScheduled, {
      bulkRunner: runner,
      bulkActionsRegistry: makeRegistry(),
    })
    ok('bulk in registered list', registered.includes('bulk'), JSON.stringify(registered))
    ok('bulk handler attached', typeof captured.bulk === 'function')
    // Smoke: the attached handler actually works.
    const out = await captured.bulk({
      spec: { actionId: 'ig_like', identityIds: ['x'] },
    })
    ok('attached handler delegates to runner', out && out.ok === true)
  }

  section('registerScheduledActionHandlers skips bulk without bulkRunner')
  {
    const fakeScheduled = { setHandler: () => {} }
    const registered = registerScheduledActionHandlers(fakeScheduled, {})
    ok(
      'bulk NOT in registered (no runner)',
      !registered.includes('bulk'),
      JSON.stringify(registered),
    )
  }

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
