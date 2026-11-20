import { nextTick } from 'vue'
import {
	ref,
	watchEffectAsyncLightest as watchEffectAsyncLight,
	reactive,
	EffectFlags,
	observeDependenciesIn,
	AsyncEffectHelperInterface,
	RunInfoFlags,
	ReactiveFlags2,
	ReactiveEffectAsync,
} from '../src'
import {
	AsyncEffectHelper,
	ReactiveEffectNestableInterface,
	effect,
	SectionFlags,
} from '../src/effect'
import { getActiveSub } from '../src/system'
import {
	getDeps2,
	getDeps,
	getDeps3 as _getDeps3,
	getDepLinks,
	getActiveDeps,
} from '../src/testHelpers'
var getDeps3 = _getDeps3

function random(min: number, max: number) {
	// The maximum is inclusive and the minimum is inclusive
	const minCeiled = Math.ceil(min)
	const maxFloored = Math.floor(max)
	return Math.floor(Math.random() * (maxFloored - minCeiled + 1) + minCeiled)
}
var sleep_test = async (ms = 1) => {
	if (vi.isFakeTimers()) {
		await vi.advanceTimersByTimeAsync(ms)
	} else {
		return sleep(ms)
	}
}
var sleep = (ms = 1) => new Promise(r => setTimeout(r, ms))
const getFirstKey = <K>(map: Map<K, any> | Set<K>) => map.keys().next().value
const areEqual = (a1: any[], a2: any[]) =>
	a1 && a1?.length === a2?.length && a1.every((x, i) => x === a2[i])
async function awaitCompletion(
	e: ReactiveEffectNestableInterface,
	toAwaitAll?: any,
	timeInc: number = 100000,
) {
	if (vi.isFakeTimers()) {
		let completion = e.awaitCompletion(toAwaitAll)
		completion.catch(() => { })
		await vi.advanceTimersByTimeAsync(timeInc!)
		return completion
	} else {
		return e.awaitCompletion(toAwaitAll)
	}
}

describe('watchEffectAsyncLight', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{
			label: 'not reentrant, not livetracking, EnabledSections',
			flags: EffectFlags.EnabledSections,
		},
	])('if sync mode works ($label)', async ({ label, flags }) => {
		let dummy
		const obj = reactive({ prop: 'value', run: false })
		const v2 = ref(2)
		v2.id = 'v2'

		// Recursive triggering is only allowed if the flag TriggerSynchronously is set along with ALLOW_RECURSE
		// It's to mirror watchEffect behavior but it's not allowed otherwise
		let toRecurseInfinitely = false
		let numRuns = 0
		let hasRecursedInfinitely: Boolean = false
		let toThrowError: Boolean = false
		const eSpy = vi.fn(() => {
			dummy = obj.run ? obj.prop : 'other'
			++numRuns
			if (toRecurseInfinitely) {
				if (numRuns > 120) {
					hasRecursedInfinitely = true
					return
				}
				++v2.value
			} else {
				v2.value
			}
			if (toThrowError) {
				throw 'test error'
			}
		})

		var e = watchEffectAsyncLight(eSpy, {
			flags: flags | EffectFlags.TriggerSynchronously,
		})

		expect(e.runs.size).toBe(0)

		var deps = e.getDeps()
		expect(dummy).toBe('other')
		expect(eSpy).toHaveBeenCalledTimes(1)
		obj.prop = 'Hi'
		deps = e.getDeps()
		expect(dummy).toBe('other')
		expect(eSpy).toHaveBeenCalledTimes(1)

		obj.run = true
		deps = e.getDeps()
		let expectedDeps2 = [
			...observeDependenciesIn(() => {
				; (obj.run, obj.prop, v2.value)
			}),
		]
		expect(deps).toEqual(expectedDeps2)

		expect(dummy).toBe('Hi')
		expect(eSpy).toHaveBeenCalledTimes(2)
		obj.prop = 'World'
		expect(dummy).toBe('World')
		expect(eSpy).toHaveBeenCalledTimes(3)

		// recursive triggering
		e.flags |= EffectFlags.ALLOW_RECURSE
		assert(hasRecursedInfinitely === false, 'hasRecursedInfinitely')
		++v2.value
		assert(hasRecursedInfinitely === false, 'hasRecursedInfinitely')
		toRecurseInfinitely = true
		++v2.value
		assert(hasRecursedInfinitely === true, 'hasRecursedInfinitely')
		toRecurseInfinitely = false
		expect(v2.subs).toBe(undefined) // unvisit

		// sync error
		// - it is possible to indicate a synchronous error in effect.endRun() and then set a field or call a sync handler for that, but that is not implemented currently
		toThrowError = true
		var runPromise, error
		e.onBeforeStart = promise => {
			runPromise = promise
		}
		obj.prop = 'World2'
		try {
			await runPromise
		} catch (err) {
			error = err
		}
		expect(error).toBe('test error')
		expect(e.runs.size).toBe(0)

		// const handler = vi.fn();
		// process.on('unhandledRejection', handler);
		// expect(handler).not.toHaveBeenCalled();
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{ label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
		{ label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },

		{
			label: 'reentrant, livetracking',
			flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
		},

		{
			label: 'reentrant, livetracking, EnabledSections',
			flags:
				EffectFlags.REENTRANT |
				EffectFlags.LIVETRACKING |
				EffectFlags.EnabledSections,
		},

		{
			label: 'not reentrant, not livetracking, EnabledSections',
			flags: EffectFlags.EnabledSections,
		},
	])('if async mode works ($label)', async ({ label, flags }) => {
		// More reliable and less error prone than the promise-based method
		// - uses generator functions (including async generators) instead of normal async functions
		// - uses "yield" instead of "await". They fulfill the same function.
		// - Can call and yield generator functions as if they were async functions.
		// - every left side of a "yield" runs after a tick if a promise was yielded or in an async function, same as "await".
		// Advantages:
		// - promises no longer have to be wrapped with `var r = await x.resume(promise)`. They can be yielded directly: `var r = yield promise`
		// - Callbacks for then() handlers still have to be wrapped:  `promise.then(x.resume((r)=>{...}))`
		//   But they can receive generator functions which can act like async functions, so then() resolves when the whole generator finishes

		// vi.useRealTimers()

		expect(__DEV__).toBe(true)
		const LIVETRACKING = flags & EffectFlags.LIVETRACKING
		const REENTRANT = flags & EffectFlags.REENTRANT
		const EnabledSections = flags & EffectFlags.EnabledSections

		const obj = reactive({ prop: 'value', run: <any>false })
		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v5 = ref(6)
		v5.id = 'v5'
		var calledTimes = 0

		function check(effect: ReactiveEffectAsync, area: string) {
			//   console.log(effect.effectId, area)
			let activeSub = getActiveSub()
			let isThisEffectRunnung = activeSub?.activeRun?.effect === effect
			if (!isThisEffectRunnung) {
				throw '!isThisEffectRunnung - area ' + area
			}
		}

		async function doWork1() {
			await sleep(100)
		}
		function* innerFunc(x: AsyncEffectHelper): any {
			// area2_1
			yield sleep(100)
			// area2_2
			yield doWork1()
			// area2_3
			return yield sleep(100).then(
				x.resume(async function* () {
					// area2_4
					yield sleep(100)
					// area2_5
				}),
			)
		}

		function* doTaskAsync(x: AsyncEffectHelper) {
			// area1_1
			check(x.effect, 'area1_1')
			++calledTimes
			let dummy = obj.run ? obj.prop : 'other'
			yield sleep(100)
			// area1_2
			++v2.value
			let promise_innerFunc = innerFunc(x)
			// area1_3
			yield promise_innerFunc
			// area1_4
			if (v3.value > 10) {
				v4.value
			} else {
				v5.value
			}
			yield sleep(100).then(
				x.resume(function* () {
					// area1_5
					yield sleep(100)
					// area1_6
				}),
			)
			// area1_7
			yield doWork1()
			// area1_8
		}

		var e = watchEffectAsyncLight(doTaskAsync as any, {
			flags: flags,
		})
		e.ID = 'Effect1'
		const e_sub = EnabledSections ? e.rootSection : e

		expect(calledTimes).toBe(1)
		await nextTick()
		expect(calledTimes).toBe(1)
		expect(e.runs.size).toBe(1)
		if (LIVETRACKING) {
			if (EnabledSections) {
				expect(getDeps2(e.rootSection as any).length).toBe(1)
			} else {
				expect(e.getDeps().length).toBe(1)
			}
		} else {
			expect(e.getDeps().length).toBe(0)
		}
		await awaitCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(calledTimes).toBe(1)
		let deps = e.getDeps()
		let expectedDeps = [
			...observeDependenciesIn(() => {
				; (obj.run, v2.value, v3.value, v5.value)
			}),
		]
		expect(deps).toEqual(expectedDeps)
		if (EnabledSections) {
			expect(getDeps3(e.rootSection as any)).toEqual(['run', 'v2', 'v3', 'v5'])
		}

		obj.run = null
		expect(e.flags & EffectFlags.IsScheduledRun).toBe(
			EffectFlags.IsScheduledRun,
		)
		expect(e.runs.size).toBe(0)
		v3.value = 5
		expect(e.runs.size).toBe(0)
		await nextTick()
		expect(e.runs.size).toBe(1)
		if (LIVETRACKING) {
		}
		await awaitCompletion(e)
		expect(e.runs.size).toBe(0)
		deps = e.getDeps()
		expect(deps).toEqual(expectedDeps)

		var v5_subs = v5.getSubs()
		expect(v5_subs.length).toBe(1)
		expect(v5_subs[0]).toBe(e_sub)

		v3.value = 20
		obj.run = true
		await nextTick()
		expect(e.runs.size).toBe(1)
		await awaitCompletion(e)
		deps = e.getDeps()
		let expectedDeps2 = [
			...observeDependenciesIn(() => {
				; (obj.run, obj.prop, v2.value, v3.value, v4.value)
			}),
		]
		expect(deps).toEqual(expectedDeps2)
		if (EnabledSections) {
			expect(getDeps3(e.rootSection as any)).toEqual([
				'run',
				'prop',
				'v2',
				'v3',
				'v4',
			])
		}
		calledTimes = 0
		var v5_subs = v5.getSubs()
		expect(v5_subs.length).toBe(0)
		v5.value
		expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)
		await nextTick()
		expect(calledTimes).toBe(0)
		expect(e.runs.size).toBe(0)

		e.pause()
		++v3.value
		++v4.value
		expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)
		await nextTick()
		expect(calledTimes).toBe(0)
		expect(e.runs.size).toBe(0)

		e.resume()
		expect(e.flags & EffectFlags.IsScheduledRun).toBe(
			EffectFlags.IsScheduledRun,
		)
		await nextTick()
		expect(calledTimes).toBe(1)
		await awaitCompletion(e)
		expect(
			areEqual(e.getDeps(), [
				...observeDependenciesIn(() => {
					; (obj.run, obj.prop, v2.value, v3.value, v4.value)
				}),
			]),
		).toBe(true)
		if (EnabledSections) {
			expect(getDeps3(e.rootSection as any)).toEqual([
				'run',
				'prop',
				'v2',
				'v3',
				'v4',
			])
		}

		if (REENTRANT) {
			++v2.value
			expect(e.flags & EffectFlags.IsScheduledRun).toBe(
				EffectFlags.IsScheduledRun,
			)
			await nextTick()
			expect(e.runs.size).toBe(1)
			expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)

			++v3.value
			expect(e.flags & EffectFlags.IsScheduledRun).toBe(
				EffectFlags.IsScheduledRun,
			)
			await nextTick()
			expect(e.runs.size).toBe(2)
			expect(e.flags & EffectFlags.IsScheduledRun).toBe(0)
			await awaitCompletion(e, true)
			expect(e.runs.size).toBe(0)
		}

		e.stop()
		expect(areEqual(e.getDeps(), [])).toBe(true)
		let allUnlinked = expectedDeps2.every(d => d.getSubs().length == 0)
		expect(allUnlinked).toBe(true)
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{ label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
		{ label: 'reentrant, livetracking', flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING },
		{ label: 'reentrant, not livetracking, EnabledSections', flags: EffectFlags.REENTRANT | EffectFlags.EnabledSections },
		{
			label: 'not reentrant, not livetracking, EnabledSections',
			flags: EffectFlags.EnabledSections,
		},
	])('async complex ($label)', async ({ label, flags }) => {
		// vi.useRealTimers()
		expect(__DEV__).toBe(true)
		const LIVETRACKING = flags & EffectFlags.LIVETRACKING
		const REENTRANT = flags & EffectFlags.REENTRANT

		const obj = reactive({ prop: 'value', run: <any>false })
		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v5 = ref(6)
		v5.id = 'v5'
		var calls = 0
		const min = 10,
			max = 30

		function check(effect: ReactiveEffectAsync, area: string) {
			// console.log(effect.effectId, area)

			let activeSub = getActiveSub()
			let isThisEffectRunnung = activeSub?.activeRun?.effect === effect
			if (!isThisEffectRunnung) {
				throw '!isThisEffectRunnung - area ' + area
			}
		}

		async function* innerFunc(x: AsyncEffectHelper) {
			// area2_1
			check(x.effect, 'area2_1')
			yield sleep(random(min, max))
			// area2_2
			check(x.effect, 'area2_2')
			yield sleep(random(min, max))
			// area2_3
			check(x.effect, 'area2_3')
			return sleep(random(min, max)).then(
				x.resume(function* () {
					// area2_4
					check(x.effect, 'area2_4')
					yield sleep(random(min, max))
					// area2_5
					check(x.effect, 'area2_5')
				}),
			)
		}
		function* F(x: AsyncEffectHelper) {
			// area1_1
			++calls
			v2.value
			check(x.effect, 'area1_1')
			yield sleep(random(min, max))
			// area1_2
			v3.value
			check(x.effect, 'area1_2')
			let generatorIterator_innerFunc = innerFunc(x)
			// area1_3
			check(x.effect, 'Problem area area1_3')
			yield generatorIterator_innerFunc
			// area1_4
			check(x.effect, 'area1_4')
			yield sleep(random(min, max)).then(
				x.resume(function* () {
					// area1_5
					check(x.effect, 'area1_5')
					yield sleep(random(min, max))
					// area1_6
					check(x.effect, 'area1_6')
				}),
			)
			// area1_7
			check(x.effect, 'area1_7')
			yield sleep(random(min, max))
			// area1_8
			check(x.effect, 'area1_8')
		}

		var e1 = watchEffectAsyncLight('E1', F, {
			flags: flags,
		})

		expect(calls).toBe(1)
		await nextTick()
		expect(calls).toBe(1)
		expect(e1.runs.size).toBe(1)
		if (LIVETRACKING) {
			expect(e1.getDeps().length).toBe(1)
		} else {
			expect(e1.getDeps().length).toBe(0)
		}
		await expect(awaitCompletion(e1, true)).resolves.not.toThrow()
		expect(e1.runs.size).toBe(0)
		expect(calls).toBe(1)
		expect(areEqual(e1.getDeps(), [v2, v3])).toBe(true)

		var e2 = watchEffectAsyncLight('E2', F, {
			flags: flags,
		})
		var e3 = watchEffectAsyncLight('E3', F, {
			flags: flags,
		})

		// await expect(awaitCompletion(e, true)).rejects.toThrow()
		await expect(awaitCompletion(e2, true)).resolves.not.toThrow()
		await expect(awaitCompletion(e3, true)).resolves.not.toThrow()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(0)

		++v2.value
		await nextTick()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(3)
		await sleep_test(50)
		++v2.value
		await nextTick()
		if (REENTRANT) {
			expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(6)
		} else {
			expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(3)
			expect(
				e1.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
			).toBe(EffectFlags.ScheduleRunAfterCurrentRun)
			e3.flags = e2.flags = e1.flags &= ~EffectFlags.ScheduleRunAfterCurrentRun
		}
		await expect(
			Promise.all([
				awaitCompletion(e1, true),
				awaitCompletion(e2, true),
				awaitCompletion(e3, true),
			]),
		).resolves.not.toThrow()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(0)
		await nextTick()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(0)
	})

	test.each([
		{
			label: 'not reentrant, not livetracking',
			flags: EffectFlags.EnabledSections,
		},
		{
			label: 'reentrant, not livetracking',
			flags: EffectFlags.REENTRANT | EffectFlags.EnabledSections,
		},
		{
			label: 'not reentrant, livetracking',
			flags: EffectFlags.LIVETRACKING | EffectFlags.EnabledSections,
		},
		{
			label: 'reentrant, livetracking',
			flags:
				EffectFlags.REENTRANT |
				EffectFlags.LIVETRACKING |
				EffectFlags.EnabledSections,
		},
	])('async complex + sections ($label)', async ({ label, flags }) => {
		// vi.useRealTimers()
		expect(__DEV__).toBe(true)
		const LIVETRACKING = flags & EffectFlags.LIVETRACKING
		const REENTRANT = flags & EffectFlags.REENTRANT

		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v5 = ref(6)
		v5.id = 'v5'
		var calls = 0
		const min = 10,
			max = 30

		function check(
			effect: ReactiveEffectAsync,
			area: string,
			sectionID: any = 'root',
		) {
			// console.log(effect.effectId, area)

			let activeSub = getActiveSub()
			let isThisEffectRunnung = activeSub?.activeRun?.effect === effect
			if (!isThisEffectRunnung) {
				throw '!isThisEffectRunnung - area ' + area
			}
			if (sectionID && activeSub?.activeRun?.currentSection?.ID !== sectionID) {
				throw 'wrong sectionID -  area ' + area + ` - ${sectionID}`
			}
		}

		async function* innerFunc(x: AsyncEffectHelper) {
			// area2_1
			x.section(
				'_1_',
				() => {
					// area2_1_s1
					check(x.effect, 'area2_1_s1', '_1_')
				},
				undefined,
				SectionFlags.NOSKIP,
			)
			check(x.effect, 'area2_1')
			yield sleep(random(min, max))
			// area2_2
			check(x.effect, 'area2_2')
			yield sleep(random(min, max))
			// area2_3
			x.section(
				'_2_',
				() => {
					// area2_1_s2
					check(x.effect, 'area2_3_s2', '_2_')
				},
				undefined,
				SectionFlags.NOSKIP,
			)
			check(x.effect, 'area2_3')
			return sleep(random(min, max)).then(
				x.resume(function* () {
					// area2_4
					check(x.effect, 'area2_4')
					yield sleep(random(min, max))
					// area2_5
					check(x.effect, 'area2_5')
					x.section(
						'_3_',
						() => {
							// area2_5_s3
							check(x.effect, 'area2_5_s3', '_3_')
						},
						undefined,
						SectionFlags.NOSKIP,
					)
				}),
			)
		}
		function* F(x: AsyncEffectHelper) {
			// area1_1
			++calls
			v2.value
			check(x.effect, 'area1_1')
			yield sleep(random(min, max))
			// area1_2
			v3.value
			check(x.effect, 'area1_2')
			x.section(
				'_01_',
				function* () {
					// area1_2_s1
					check(x.effect, 'area1_2_s1', '_01_')
				},
				undefined,
				SectionFlags.NOSKIP,
			)
			let generatorIterator_innerFunc = innerFunc(x)
			// area1_3
			check(x.effect, 'Problem area area1_3')
			yield generatorIterator_innerFunc
			// area1_4
			check(x.effect, 'area1_4')
			yield x.section(
				'_02_',
				async function* () {
					// area1_4_s2
					check(x.effect, 'area1_4_s2', '_02_')
					yield sleep(random(min, max))
					// area1_4_2_s2
					check(x.effect, 'area1_4_2_s2', '_02_')
				},
				undefined,
				SectionFlags.NOSKIP,
			)
			yield sleep(random(min, max)).then(
				x.resume(function* () {
					// area1_5
					check(x.effect, 'area1_5')
					x.section(
						'_030_',
						function* () {
							// area1_5_s30
							check(x.effect, 'area1_5_s30', '_030_')
						},
						undefined,
						SectionFlags.NOSKIP,
					)
					yield sleep(random(min, max))
					// area1_6
					check(x.effect, 'area1_6')
					x.section(
						'_03_',
						function* () {
							// area1_6_s3
							check(x.effect, 'area1_6_s3', '_03_')
						},
						undefined,
						SectionFlags.NOSKIP,
					)
				}),
			)
			// area1_7
			check(x.effect, 'area1_7')
			yield x.section(
				'_04_',
				async function* () {
					// area1_7_s3
					check(x.effect, 'area1_7_s3', '_04_')
					yield sleep(random(min, max))
					// area1_7_2_s3
					check(x.effect, 'area1_7_2_s3', '_04_')
				},
				undefined,
				SectionFlags.NOSKIP,
			)
			yield sleep(random(min, max))
			// area1_8
			check(x.effect, 'area1_8')
		}

		var e1 = watchEffectAsyncLight('E1', F, {
			flags: flags,
		})

		expect(calls).toBe(1)
		await nextTick()
		expect(calls).toBe(1)
		expect(e1.runs.size).toBe(1)
		if (LIVETRACKING) {
			expect(getDeps2(e1.rootSection as any).length).toBe(1)
		} else {
			expect(e1.getDeps().length).toBe(0)
		}
		await expect(awaitCompletion(e1, true)).resolves.not.toThrow()
		expect(e1.runs.size).toBe(0)
		expect(calls).toBe(1)
		expect(areEqual(e1.getDeps(), [v2, v3])).toBe(true)

		var e2 = watchEffectAsyncLight('E2', F, {
			flags: flags,
		})
		var e3 = watchEffectAsyncLight('E3', F, {
			flags: flags,
		})

		// await expect(awaitCompletion(e, true)).rejects.toThrow()
		await expect(awaitCompletion(e2, true)).resolves.not.toThrow()
		await expect(awaitCompletion(e3, true)).resolves.not.toThrow()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(0)

		++v2.value
		await nextTick()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(3)
		await sleep_test(50)
		++v2.value
		await nextTick()
		if (REENTRANT) {
			expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(6)
		} else {
			expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(3)
			expect(
				e1.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
			).toBe(EffectFlags.ScheduleRunAfterCurrentRun)
			e3.flags = e2.flags = e1.flags &= ~EffectFlags.ScheduleRunAfterCurrentRun
		}
		await expect(
			Promise.all([
				awaitCompletion(e1, true),
				awaitCompletion(e2, true),
				awaitCompletion(e3, true),
			]),
		).resolves.not.toThrow()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(0)
		await nextTick()
		expect(e1.runs.size + e2.runs.size + e3.runs.size).toBe(0)
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{ label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
		{ label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
		{
			label: 'reentrant, livetracking',
			flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
		},
		{
			label: 'reentrant, livetracking, EnabledSections',
			flags:
				EffectFlags.REENTRANT |
				EffectFlags.LIVETRACKING |
				EffectFlags.EnabledSections,
		},
		{
			label: 'not reentrant, not livetracking, EnabledSections',
			flags: EffectFlags.EnabledSections,
		},
		{
			label: 'not reentrant, not livetracking, EnabledSections',
			flags: EffectFlags.EnabledSections,
		},
		// Auto Aborts
		{
			label: 'Auto-abort, not reentrant, not livetracking, EnabledSections',
			flags:
				EffectFlags.AbortRunOnPause |
				EffectFlags.AbortRunOnStop |
				EffectFlags.AbortRunOnRetrigger |
				EffectFlags.EnabledSections,
		},
		{
			label: 'Auto-abort, reentrant, not livetracking, EnabledSections',
			flags:
				EffectFlags.AbortRunOnPause |
				EffectFlags.AbortRunOnStop |
				EffectFlags.AbortRunOnRetrigger |
				EffectFlags.REENTRANT |
				EffectFlags.EnabledSections,
		},
		{
			label: 'Auto-abort, reentrant, livetracking, EnabledSections',
			flags:
				EffectFlags.AbortRunOnPause |
				EffectFlags.AbortRunOnStop |
				EffectFlags.AbortRunOnRetrigger |
				EffectFlags.REENTRANT |
				EffectFlags.LIVETRACKING |
				EffectFlags.EnabledSections,
		},
	])('abortions ($label)', async ({ label, flags }) => {
		expect(__DEV__).toBe(true)
		let REENTRANT = flags & EffectFlags.REENTRANT
		const AbortRunOnRetrigger = flags & EffectFlags.AbortRunOnRetrigger
		const EnabledSections = flags & EffectFlags.EnabledSections

		var n1, n2, n3, n4, n5
		n1 = n2 = n3 = n4 = n5 = 0
		var toTrack_v0 = 0

		const v0 = ref(0)
		v0.id = 'v0'
		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v5 = ref(6)
		v5.id = 'v5'

		const eSpy = vi.fn(async function* (x: AsyncEffectHelperInterface) {
			n1 = n2 = n3 = n4 = n5 = 0
			++v2.value
			n1 = 1
			if (toTrack_v0) {
				++v0.value
			}
			yield sleep(50)
			++v3.value
			n2 = 1
			yield sleep(50)
			++v4.value
			n3 = 1
			yield sleep(70)
			n4 = 1
			return x.resume(
				sleep(90).then(
					x.resume(() => {
						n5 = 1
						++v5.value
					}),
				),
			)
		})

		var e = watchEffectAsyncLight(eSpy, {
			flags: flags,
		})
		e.maxConcurrentRuns = 3

		// verify flag auto-correction
		if (REENTRANT && AbortRunOnRetrigger) {
			expect(
				e.flags & (EffectFlags.REENTRANT | EffectFlags.AbortRunOnRetrigger),
				'REENTRANT is ignored if AbortRunOnRetrigger',
			).toBe(EffectFlags.AbortRunOnRetrigger)
			REENTRANT = 0
		}

		expect(eSpy).toHaveBeenCalledTimes(1)
		await nextTick()
		expect(eSpy).toHaveBeenCalledTimes(1)
		expect(e.runs.size).toBe(1)
		await awaitCompletion(e, true)
		expect(n1 + n2 + n3 + n4 + n5).toBe(5)
		var deps = e.getDeps()
		let expectedDeps2 = [...observeDependenciesIn([v2, v3, v4, v5])]
		expect(deps).toEqual(expectedDeps2)

		++v5.value
		await sleep_test(2)
		await awaitCompletion(e, true)
		expect(e.runs.size).toBe(0)
		expect(areEqual(e.getDeps(), [v2, v3, v4, v5])).toBe(true)

		// manual abort
		toTrack_v0 = 1
		++v5.value
		await sleep_test(2)
		expect(e.runs.size).toBe(1)
		++v5.value
		if (REENTRANT) {
			expect(
				e.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
				'reentrant effects will rerun when triggered by uncollected deps',
			).toBe(EffectFlags.IsScheduledRun)
		} else {
			expect(
				e.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
			).toBe(0) // not collected yet so no re-trigger if AbortRunOnRetrigger
		}
		await sleep_test(111)
		expect(e.runs.size).toBe(REENTRANT ? 2 : 1)
		expect(areEqual(e.getCollectedDeps(), [v2, v0, v3, v4])).toBe(true)
		e.abort() // stop before n4
		expect(e.runs.size).toBe(0)
		await sleep_test(100)
		expect(n1 == 1 && n2 == 1 && n3 == 1 && n4 == 0 && n5 == 0).toBe(true)
		expect(
			areEqual(e.getDeps(), [v2, v3, v4, v5]),
			'existing deps are preserved if aborted',
		).toBe(true)
		EnabledSections &&
			expect(areEqual(getActiveDeps(e.rootSection!), [v2, v3, v4, v5])).toBe(
				true,
			)
		toTrack_v0 = 0

		// then() handler aborted
		++v2.value
		await sleep_test(1)
		expect(e.runs.size).toBe(1)
		await sleep_test(210)
		expect(n1 == 1 && n2 == 1 && n3 == 1 && n4 == 1 && n5 == 0).toBe(true)
		expect(e.runs.size).toBe(1)
		e.abort() // stop before n5
		expect(e.runs.size).toBe(0)
		await sleep_test(130)
		expect(n5 == 0).toBe(true)
		expect(areEqual(e.getDeps(), [v2, v3, v4, v5])).toBe(true)
		EnabledSections &&
			expect(areEqual(getActiveDeps(e.rootSection!), [v2, v3, v4, v5])).toBe(
				true,
			)

		// auto abort
		++v2.value
		await sleep_test(1)
		expect(e.runs.size).toBe(1)
		let run = getFirstKey(e.runs)!
		++v2.value
		if (REENTRANT) {
			if (AbortRunOnRetrigger) {
				assert.fail('REENTRANT + AbortRunOnRetrigger')
			} else {
				expect(
					e.flags &
					(EffectFlags.IsScheduledRun |
						EffectFlags.ScheduleRunAfterCurrentRun),
				).toBe(EffectFlags.IsScheduledRun)
				expect(run.flags & RunInfoFlags.Aborted).toBe(0)
				await sleep_test(1)
				expect(e.runs.size).toBe(2)
				++v2.value
				await sleep_test(1)
				expect(e.runs.size).toBe(3)
				++v2.value
				await sleep_test(1)
				expect(e.maxConcurrentRuns).toBe(3)
				expect(e.runs.size, 'respects maxConcurrentRuns').toBe(3)
			}
		} else {
			if (AbortRunOnRetrigger) {
				expect(
					e.flags &
					(EffectFlags.IsScheduledRun |
						EffectFlags.ScheduleRunAfterCurrentRun),
				).toBe(
					EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun,
				)
				expect(e.runs.size).toBe(0)
				expect(!!e.abortedRun).toBe(true)
				expect(run.flags & RunInfoFlags.Aborted).toBe(RunInfoFlags.Aborted)
				await nextTick()
				expect(e.runs.size).toBe(1)
				expect(!!e.abortedRun).toBe(false)
				let runNew = getFirstKey(e.runs)!
				expect(runNew).not.toBe(run)
				expect(runNew.promise).toBe(run.promise)
				expect(runNew.flags & RunInfoFlags.Restarted).toBe(
					RunInfoFlags.Restarted,
				)
				expect(
					runNew.collectedDeps.size == 1 &&
					getFirstKey(runNew.collectedDeps) === (v2 as any),
				).toBe(true)

				++v2.value
				await nextTick()
				let runNew2 = getFirstKey(e.runs)!
				expect(
					runNew2 &&
					runNew2 !== runNew &&
					(runNew.flags & RunInfoFlags.Restarted) == RunInfoFlags.Restarted,
				).toBe(true)
				++v5.value
				expect(
					e.flags &
					(EffectFlags.IsScheduledRun |
						EffectFlags.ScheduleRunAfterCurrentRun),
					'v5 should not retrigger because not collected',
				).toBe(0)
				expect(runNew2.flags & RunInfoFlags.Aborted).toBe(0)
			} else {
				expect(
					e.flags &
					(EffectFlags.IsScheduledRun |
						EffectFlags.ScheduleRunAfterCurrentRun),
				).toBe(EffectFlags.ScheduleRunAfterCurrentRun)
				await sleep_test(1)
				let run2 = getFirstKey(e.runs)
				expect(run2).toBe(run)
			}
		}

		await awaitCompletion(e, true)
		expect(e.runs.size).toBe(0)
		expect(!!e.abortedRun).toBe(false)
		expect(
			e.flags &
			(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
		).toBe(0)
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{ label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
		{ label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
		{
			label: 'reentrant, livetracking',
			flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
		},
		// Auto Aborts
		{
			label: 'Auto-abort, not reentrant, not livetracking, EnabledSections',
			flags:
				EffectFlags.AbortRunOnPause |
				EffectFlags.AbortRunOnStop |
				EffectFlags.AbortRunOnRetrigger |
				EffectFlags.EnabledSections,
		},
		{
			label: 'Auto-abort, reentrant, not livetracking, EnabledSections',
			flags:
				EffectFlags.AbortRunOnPause |
				EffectFlags.AbortRunOnStop |
				EffectFlags.AbortRunOnRetrigger |
				EffectFlags.REENTRANT |
				EffectFlags.EnabledSections,
		},
		{
			label: 'Auto-abort, reentrant, livetracking, EnabledSections',
			flags:
				EffectFlags.AbortRunOnPause |
				EffectFlags.AbortRunOnStop |
				EffectFlags.AbortRunOnRetrigger |
				EffectFlags.REENTRANT |
				EffectFlags.LIVETRACKING |
				EffectFlags.EnabledSections,
		},
	])('sections, stateless ($label)', async ({ label, flags }) => {
		expect(__DEV__).toBe(true)
		flags |= EffectFlags.EnabledSections | EffectFlags.STATELESS
		let REENTRANT = flags & EffectFlags.REENTRANT
		const AbortRunOnRetrigger = flags & EffectFlags.AbortRunOnRetrigger

		var n1, n2, n3, n4, n5
		n1 = n2 = n3 = n4 = n5 = 0

		var n1_inner, n2_inner, n3_inner, n4_inner, n5_inner
		n1_inner = n2_inner = n3_inner = n4_inner = n5_inner = 0

		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v5 = ref(5)
		v5.id = 'v5'
		const v6 = ref(6)
		v6.id = 'v6'

		const v7 = ref(2)
		v7.id = 'v7'
		const v8 = ref(3)
		v8.id = 'v8'
		const v9 = ref(9)
		v9.id = 'v9'
		const v10 = ref(10)
		v10.id = 'v10'
		const v11 = ref(11)
		v11.id = 'v11'

		const db: any = { 1: 1, 2: 2, 3: 3, 4: 4 }
		const param = ref(1)
		param.id = 'param'
		var doWork = (x: any): any => db[x]
		var toChangeV3_1 = false
		var toThrow = false
		var wasRun_0 = 0,
			wasRun_1 = 0,
			wasRun_2 = 0,
			wasRun_3 = 0
		var enableBranchLoop = 0,
			numTimesLoopedBranchWasRun = 0,
			numTimesLoopedBranchWasSkipped = 0,
			enableChangeLoopBranchDepsFromOutside = 0
		var cache_1_: any, cache_2_: any, cache_3_: any, cache_0_: any

		function* innerWork(p: any, x: AsyncEffectHelperInterface) {
			n1_inner = 1

			// synchronous
			x.section('_1_', x => {
				wasRun_1 = 1
				if (v2.value > 10) {
					cache_1_ = doWork(v4.value)
				} else {
					cache_1_ = 'xx'
				}
			})

			// asynchronous
			yield x.section('_2_', async function* () {
				wasRun_2 = 1
				if (v3.value > 10) {
					if (toChangeV3_1) {
						++v3.value
					}
					if (startTime) {
						// console.log(-startTime + performance.now())
					}
					yield sleep(10)
					n2_inner = 1
					if (startTime) {
						// console.log(-startTime + performance.now())
					}

					yield x.section('_3_', async function* () {
						wasRun_3 = 1
						cache_3_ = v5.value + 'zz'
						if (toThrow) {
							throw 'myError'
						}
						yield x.section('_4_', async function* () {
							v10.value
							if (enableBranchLoop) {
								for (var i = 0; i < 10; i++) {
									x.section(
										'_Looped_',
										x => {
											++v11.value
											++numTimesLoopedBranchWasRun
										},
										() => {
											++numTimesLoopedBranchWasSkipped
										},
									)
									if (enableChangeLoopBranchDepsFromOutside) {
										if (i < 3) {
											++v11.value
										}
									}
								}
							}
						})
					})

					yield sleep(70)
					n3_inner = 1

					cache_2_ = cache_3_ + '!'
				} else {
					cache_2_ = 'yy'
				}
			})

			return [cache_1_, cache_2_, cache_3_]
		}

		var sleep1Multiplyer: any = 1
		var final_result: any
		const eSpy = vi.fn(async function* (x: AsyncEffectHelperInterface) {
			wasRun_0 = wasRun_1 = wasRun_2 = wasRun_3 = 0
			n1 = n2 = n3 = n4 = n5 = 0
			n1_inner = n2_inner = n3_inner = n4_inner = n5_inner = 0
			final_result = 0

			++v7.value
			n1 = 1
			yield sleep(10 * sleep1Multiplyer)
			++v8.value
			n2 = 1

			yield x.section('_0_', async function* (): any {
				wasRun_0 = 1
				let innerPromise = innerWork(param.value, x)
				cache_0_ = yield innerPromise
			})

			n3 = 1

			return sleep(10).then(
				x.resume(() => {
					n4 = 1
					++v9.value
					final_result = cache_0_
					runPromiseResolver?.()
				}),
			)
		})

		var e = watchEffectAsyncLight(eSpy, {
			flags: flags,
		})
		REENTRANT = e.flags & EffectFlags.REENTRANT
		e.maxConcurrentRuns = 3

		// Tests
		await awaitCompletion(e, true)

		expect(eSpy).toHaveBeenCalledTimes(1)
		expect(e.runs.size).toBe(0)
		expect(n1 + n2 + n3 + n4).toBe(4)
		expect(n1_inner + n2_inner + n3_inner).toBe(1)
		var verifyDepsAndBranches_1 = () => {
			expect(areEqual(e.getDeps(), [v7, v8, param, v2, v3, v9])).toBe(true)
			expect(areEqual(e.getSectionDeps('_0_'), [param])).toBe(true)
			expect(e.getSectionChildrenIds('_0_')).toEqual(['_1_', '_2_'])
			expect(areEqual(e.getSectionDeps('_1_'), [v2])).toBe(true)
			expect(e.getSectionChildrenIds('_1_')).toEqual([])
			expect(areEqual(e.getSectionDeps('_2_'), [v3])).toBe(true)
			expect(e.getSectionChildrenIds('_2_')).toEqual([])
			expect(e.sectionsAll!.get('_3_')).toBe(undefined)
		}
		verifyDepsAndBranches_1()
		expect(wasRun_0 + wasRun_1 + wasRun_2).toBe(3)
		expect(wasRun_3).toBe(0)
		expect(final_result).toEqual(['xx', 'yy', undefined])

		// skips unchanged parts and re-tracks their deps
		++param.value
		expect(e.getDirtySections()).toEqual(['_0_'])
		await awaitCompletion(e, true)
		expect(e.getDirtySections()).toEqual([])
		expect(eSpy).toHaveBeenCalledTimes(2)
		expect(wasRun_0).toBe(1)
		expect(wasRun_1 + wasRun_2 + wasRun_3).toBe(0)
		expect(final_result).toEqual(['xx', 'yy', undefined])
		verifyDepsAndBranches_1()

		++v7.value
		expect(e.getDirtySections()).toEqual([])
		await awaitCompletion(e, true)
		expect(eSpy).toHaveBeenCalledTimes(3)
		expect(wasRun_0 + wasRun_1 + wasRun_2 + wasRun_3).toBe(0)
		expect(final_result).toEqual(['xx', 'yy', undefined])
		verifyDepsAndBranches_1()

		v2.value = 20
		await awaitCompletion(e, true)
		expect(final_result).toEqual([4, 'yy', undefined])
		var verifyDepsAndBranches_2 = () => {
			expect(areEqual(e.getDeps(), [v7, v8, param, v2, v4, v3, v9])).toBe(true)
			expect(areEqual(e.getSectionDeps('_0_'), [param])).toBe(true)
			expect(e.getSectionChildrenIds('_0_')).toEqual(['_1_', '_2_'])
			expect(areEqual(e.getSectionDeps('_1_'), [v2, v4])).toBe(true)
			expect(e.getSectionChildrenIds('_1_')).toEqual([])
			expect(areEqual(e.getSectionDeps('_2_'), [v3])).toBe(true)
			expect(e.getSectionChildrenIds('_2_')).toEqual([])
			expect(e.sectionsAll!.get('_3_')).toBe(undefined)
		}
		verifyDepsAndBranches_2()

		v3.value = 30
		expect(e.getDirtySections()).toEqual(['_0_', '_2_'])
		await awaitCompletion(e, true)
		expect(wasRun_0 + wasRun_2 + wasRun_3).toBe(3)
		expect(wasRun_1).toBe(0)
		var verifyDepsAndBranches_3 = () => {
			expect(
				areEqual(e.getDeps(), [v7, v8, param, v2, v4, v3, v5, v10, v9]),
			).toBe(true)
			expect(areEqual(e.getSectionDeps('_0_'), [param])).toBe(true)
			expect(e.getSectionChildrenIds('_0_')).toEqual(['_1_', '_2_'])
			expect(areEqual(e.getSectionDeps('_1_'), [v2, v4])).toBe(true)
			expect(e.getSectionChildrenIds('_1_')).toEqual([])
			expect(areEqual(e.getSectionDeps('_2_'), [v3])).toBe(true)
			expect(e.getSectionChildrenIds('_2_')).toEqual(['_3_'])
			expect(areEqual(e.getSectionDeps('_3_'), [v5])).toBe(true)
			expect(e.getSectionChildrenIds('_3_')).toEqual(['_4_'])
			expect(areEqual(e.getSectionDeps('_4_'), [v10])).toBe(true)
			expect(e.getSectionChildrenIds('_4_')).toEqual([])
		}
		verifyDepsAndBranches_3()
		expect(final_result).toEqual([4, '5zz!', '5zz'])

		++v5.value
		await awaitCompletion(e, true)
		expect(final_result).toEqual([4, '6zz!', '6zz'])

		// dep unlinking
		v3.value = 3
		v2.value = 2
		await awaitCompletion(e, true)
		var verifyDepsAndBranches_4 = () => {
			expect(areEqual(e.getDeps(), [v7, v8, param, v2, v3, v9])).toBe(true)
			expect(areEqual(e.getSectionDeps('_0_'), [param])).toBe(true)
			expect(e.getSectionChildrenIds('_0_')).toEqual(['_1_', '_2_'])
			expect(areEqual(e.getSectionDeps('_1_'), [v2])).toBe(true)
			expect(e.getSectionChildrenIds('_1_')).toEqual([])
			expect(areEqual(e.getSectionDeps('_2_'), [v3])).toBe(true)
			expect(
				e.getSectionChildrenIds('_2_'),
				'unvisited children of visited branches should not be listed',
			).toEqual([])
			expect(
				areEqual(e.getSectionDeps('_3_'), [v5]),
				'dependendies of unvisited branches should be retained',
			).toBe(true)
			expect(e.sectionsAll!.get('_3_')).not.toBe(undefined)
			expect(
				e.getSectionChildrenIds('_3_'),
				'children of unvisited branches should be retained',
			).toEqual(['_4_'])
			expect(areEqual(e.getSectionDeps('_4_'), [v10])).toBe(true)
		}
		verifyDepsAndBranches_4()

		eSpy.mockClear()
		expect(v4.subs).toBe(undefined)
		++v4.value
		expect(e.getDirtySections()).toEqual([])
		++v5.value
		expect(
			e.getDirtySections(),
			'unvisited branches should be dirtied by their deps, but they should not dirty visited branches',
		).toEqual(['_3_'])
		await awaitCompletion(e, true)
		expect(
			eSpy,
			'deps of unvisited branches should not trigger',
		).toHaveBeenCalledTimes(0)

		// many changes
		v3.value = 30
		v2.value = 20
		++param.value
		++v9.value
		++v7.value
		++v7.value
		expect(e.getDirtySections()).toEqual(['_0_', '_1_', '_2_', '_3_'])
		await awaitCompletion(e, true)
		expect(eSpy).toHaveBeenCalledTimes(1)
		expect(
			areEqual(e.getDeps(), [v7, v8, param, v2, v4, v3, v5, v10, v9]),
		).toBe(true)
		verifyDepsAndBranches_3()

		// exception detection
		toThrow = true
		++v5.value
		expect(e.getDirtySections(), 're-linked v5 should trigger').toEqual([
			'_0_',
			'_2_',
			'_3_',
		])
		var completionPromise = awaitCompletion(e, true)
		await expect(completionPromise).rejects.toThrow('myError')
		expect(e.runs.size).toBe(0)
		toThrow = false

		// abortion
		++v5.value
		await awaitCompletion(e, true)
		expect(n1_inner + n2_inner + n3_inner).toBe(3)
		++v5.value
		var startTime = performance.now()
		await sleep_test(70)
		expect(e.runs.size).toBe(1)
		e.abort()
		expect(e.runs.size).toBe(0)
		expect(n1_inner + n2_inner).toBe(2)
		expect(n3_inner).toBe(0)

		// self changes do not re-trigger (except sync recursion if wanted)
		eSpy.mockClear()
		toChangeV3_1 = true
		++v5.value
		await sleep_test(27)
		expect(e.runs.size).toBe(1)
		expect(
			e.flags &
			(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
		).toBe(0)
		await awaitCompletion(e, true)
		await sleep_test(1)
		expect(e.runs.size).toBe(0)
		expect(eSpy).toHaveBeenCalledTimes(1)

		// outside changes do re-trigger
		eSpy.mockClear()
		++v5.value
		await sleep_test(27)
		var run1 = getFirstKey(e.runs)!
		// except for not yet collected deps - they do not re-trigger - but only if not reentrant
		expect(run1.collectedDeps.has(v9 as any)).toBe(false)
		++v9.value
		if (REENTRANT) {
			expect(
				e.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
			).toBe(EffectFlags.IsScheduledRun)
			await nextTick()
			expect(e.runs.size).toBe(2)
		} else {
			expect(
				e.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
			).toBe(0)
			await nextTick()
			expect(e.runs.size).toBe(1)
			let run2 = getFirstKey(e.runs)!
			expect(run1 === run2).toBe(true)
		}
		await awaitCompletion(e, true)

		vi.useRealTimers() // Can't make fake timers work with runPromiseResolver
		sleep1Multiplyer = 10
		++v5.value
		await sleep_test(27)
		sleep1Multiplyer = 1
		var run1 = getFirstKey(e.runs)!
		// collected deps do re-trigger
		expect(run1.collectedDeps.has(v7 as any)).toBe(true)
		++v7.value
		expect(e.flags & ReactiveFlags2.Dirty).toBe(ReactiveFlags2.Dirty)
		await nextTick()
		var run2 = getFirstKey(e.runs)!
		if (REENTRANT) {
			expect(e.runs.size).toBe(2)
		} else {
			expect(e.runs.size).toBe(1)
			if (AbortRunOnRetrigger) {
				expect(run1 === run2).toBe(false)
				expect(run1.flags & RunInfoFlags.Aborted).toBe(RunInfoFlags.Aborted)
				expect(run2.flags & RunInfoFlags.Restarted).toBe(RunInfoFlags.Restarted)
			} else {
				expect(run1 === run2).toBe(true)
				expect(e.flags & EffectFlags.ScheduleRunAfterCurrentRun).toBe(
					EffectFlags.ScheduleRunAfterCurrentRun,
				)
				var runPromiseResolver: any,
					runPromise = new Promise(resolve => (runPromiseResolver = resolve))
				await runPromise
				await sleep_test(1)
				expect(e.runs.size).toBe(1)
				var run2 = getFirstKey(e.runs)!
				expect(run1 === run2).toBe(false)
			}
		}
		await e.awaitCompletion(true)
		expect(e.runs.size).toBe(0)
		vi.useFakeTimers()

		// looped branches
		enableBranchLoop = 1
		++v10.value
		await awaitCompletion(e, true)
		expect(numTimesLoopedBranchWasRun, 'self changes do not dirty').toBe(1)
		expect(numTimesLoopedBranchWasSkipped).toBe(9)
		numTimesLoopedBranchWasRun = 0
		numTimesLoopedBranchWasSkipped = 0
		enableChangeLoopBranchDepsFromOutside = 1
		++v11.value
		await awaitCompletion(e, true)
		expect(numTimesLoopedBranchWasRun, 'outside changes do dirty').toBe(4)
		expect(numTimesLoopedBranchWasSkipped).toBe(6)
		expect(e.getSectionChildrenIds('_4_')).toEqual(['_Looped_'])
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{ label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
		{ label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
		{
			label: 'reentrant, livetracking',
			flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
		},
	])('sections, stateful ($label)', async ({ label, flags }) => {
		expect(__DEV__).toBe(true)
		let REENTRANT = flags & EffectFlags.REENTRANT
		const AbortRunOnRetrigger = flags & EffectFlags.AbortRunOnRetrigger

		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v_1 = ref(4)
		v_1.id = 'v_1'
		const v_2 = ref(4)
		v_2.id = 'v_2'
		const v_3 = ref(4)
		v_3.id = 'v_3'
		const v_4 = ref(4)
		v_4.id = 'v_4'
		const inner_1 = ref(0)
		inner_1.id = 'inner_1'
		const inner_2 = ref(0)
		inner_2.id = 'inner_2'

		var wasRun_0 = 0,
			wasRun_1 = 0,
			wasRun_2 = 0,
			wasRun_3 = 0,
			wasRun_4 = 0
		var onEnd = 0,
			onStart = 0
		var test_inner_1

		const eSpy = vi.fn(async function* (x: AsyncEffectHelperInterface) {
			x.onRunStart(() => {
				++onStart
				wasRun_0 = wasRun_1 = wasRun_2 = wasRun_3 = wasRun_4 = 0
			})
			x.onRunEnd(() => {
				++onEnd
			})
			var _1 = 1
			wasRun_0 = 1

			v2.value
			yield sleep(10)
			v3.value

			yield x.section('_1_', function* (): any {
				wasRun_1 = 1
				yield sleep(10)
				++v_1.value

				yield x.section('_2_', async function* (): any {
					wasRun_2 = 1
					yield sleep(10)
					++v_2.value
					_1 = inner_1.value
				})
			})

			yield x.section('_3_', async function* (): any {
				wasRun_3 = 1
				yield sleep(10)
				++v_3.value

				yield x.section('_4_', async function* (): any {
					wasRun_4 = 1
					yield sleep(10)
					++v_4.value
					test_inner_1 = _1
				})
			})
		})

		var e = watchEffectAsyncLight(eSpy, {
			flags: flags | EffectFlags.EnabledSections,
		})
		REENTRANT = e.flags & EffectFlags.REENTRANT
		e.maxConcurrentRuns = 3

		// Tests
		await awaitCompletion(e, true)

		expect(eSpy).toHaveBeenCalledTimes(1)
		expect(e.runs.size).toBe(0)
		expect(onStart + onEnd).toBe(2)
		expect(wasRun_0 + wasRun_1 + wasRun_2 + wasRun_3 + wasRun_4).toBe(5)
		expect(test_inner_1 === inner_1.value && test_inner_1 === 0).toBe(true)

		++v_2.value
		expect(e.getDirtySections()).toEqual(['_2_'])
		await awaitCompletion(e, true)
		expect(onStart + onEnd).toBe(4)
		expect(wasRun_2).toBe(1)
		expect(wasRun_0 + wasRun_1 + wasRun_3 + wasRun_4).toBe(0)

		++v_4.value
		expect(e.getDirtySections()).toEqual(['_4_'])
		await awaitCompletion(e, true)
		expect(onStart + onEnd).toBe(6)
		expect(wasRun_4).toBe(1)
		expect(wasRun_0 + wasRun_1 + wasRun_2 + wasRun_3).toBe(0)
		expect(test_inner_1).toBe(0)

		inner_1.value = 33
		expect(e.getDirtySections()).toEqual(['_2_'])
		await awaitCompletion(e, true)
		expect(onStart + onEnd).toBe(8)
		expect(wasRun_2).toBe(1)
		expect(wasRun_0 + wasRun_1 + wasRun_3 + wasRun_4).toBe(0)

		++v_4.value
		await awaitCompletion(e, true)
		expect(test_inner_1).toBe(33)

		++v_1.value
		await awaitCompletion(e, true)
		expect(onStart + onEnd).toBe(12)
		expect(wasRun_1).toBe(1)
		expect(wasRun_0 + wasRun_2 + wasRun_3 + wasRun_4).toBe(0)

		// state update
		++v3.value
		await awaitCompletion(e, true)
		expect(onStart + onEnd).toBe(14)
		expect(wasRun_0).toBe(1)
		expect(wasRun_1 + wasRun_2 + wasRun_3 + wasRun_4).toBe(0)
		// All child closures must be updated on parent update, even if they don't run

		++v_4.value
		await awaitCompletion(e, true)
		expect(onStart + onEnd).toBe(16)
		expect(
			wasRun_3 + wasRun_4,
			'_3_ must run to update _4_ before _4_ runs',
		).toBe(2)
		expect(wasRun_0 + wasRun_1 + wasRun_2).toBe(0)
		expect(test_inner_1).toBe(1)

		inner_1.value = 44
		++v_4.value
		await awaitCompletion(e, true)
		expect(test_inner_1).toBe(44)
	})

	test('blacklists/whitelists', async () => {
		function isTriggerdBy(f: any) {
			function constraintCheck(dep: any) {
				return e.blacklist
					? !e.blacklist.has(dep)
					: e.whitelist
						? e.whitelist.has(dep)
						: true
			}
			var s = observeDependenciesIn(f)
			return e.getDeps().some((x: any) => s.has(x) && constraintCheck(x))
		}
		function areSameDeps(f: any) {
			var s = observeDependenciesIn(f)
			return areEqual(e.getDeps(), [...s])
		}
		function renew(f: any, isBlacklist: any) {
			expect(e.runs.size).toBe(0)
			e.clearDependencies()
			e.setConstraint(f, isBlacklist)
			e.run()
			return awaitCompletion(e)
		}

		const v2 = ref(2)
		const v3 = ref(3)
		const v4 = ref(4)
		const v5 = ref(5)
		const v6 = ref(2)
		const v7 = ref(2)
		const array = reactive([1, 2, 3, 4])
		const obj = reactive({ a: 1, b: 2 })

		var e = watchEffectAsyncLight(
			async function* (x: AsyncEffectHelperInterface) {
				v2.value
				yield sleep(1)
				v3.value
				yield sleep(1)
				v4.value
				yield x.section('_0_', async function* () {
					v5.value
					yield sleep(1)
					v6.value
					yield sleep(1)
					array[1]
					array.length
					obj.a = obj.b + obj.a
					'a' in obj
					yield sleep(1)
					for (var v of array) {
						break
					}
					for (var key in obj) {
						break
					}
				})
				v7.value
			},
			{ flags: EffectFlags.ManualHandling },
		)

		// whitelist
		e.setConstraint(v2, false)
		e.run()
		await awaitCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(isTriggerdBy(() => v4.value)).toBeFalsy()
		++v4.value
		++v5.value
		++v7.value
		++obj.a
		++array[1]
		expect(e.flags & ReactiveFlags2.Dirty).toBeFalsy()
		await nextTick()
		expect(e.runs.size).toBe(0)
		expect(isTriggerdBy(() => v2.value)).toBeTruthy()
		++v2.value
		expect(e.flags & ReactiveFlags2.Dirty).toBeTruthy()
		await awaitCompletion(e)

		await renew(() => {
			v4.value
			obj.a
			array[2]
		}, false)
		expect(
			areSameDeps(() => {
				v4.value
				obj.a
			}),
		).toBe(true)
		expect(isTriggerdBy(v4)).toBeTruthy()
		expect(isTriggerdBy(() => obj.a)).toBeTruthy()
		expect(isTriggerdBy(() => array[1])).toBeFalsy() // not whitelisted
		expect(isTriggerdBy(() => array[2])).toBeFalsy() // whitelisted but not tracked
		expect(isTriggerdBy(() => v5.value)).toBeFalsy()
		expect(isTriggerdBy(() => 'x' in obj)).toBeFalsy()
		expect(isTriggerdBy(() => obj.b)).toBeFalsy()

		await renew(() => {
			'a' in obj
		}, false)

		expect(isTriggerdBy(() => 'a' in obj)).toBeTruthy()
		expect(isTriggerdBy(() => 'x' in obj)).toBeFalsy()

		// blacklist
		await renew(v2 as any, true)
		expect(e.runs.size).toBe(0)
		expect(
			areSameDeps(() => {
				v3.value
				v4.value
				v5.value
				v6.value
				array[1]
				array.length
				obj.b
				obj.a
				'a' in obj
				for (var v of array) {
					break
				}
				for (var key in obj) {
					break
				}
				v7.value
			}),
		).toBe(true)
		expect(isTriggerdBy(v2)).toBeFalsy()
		expect(isTriggerdBy(() => obj.a)).toBeTruthy()
		expect(isTriggerdBy(() => array[1])).toBeTruthy()
	})

	test.each([
		{ label: 'not reentrant, not livetracking', flags: 0 },
		{ label: 'reentrant, not livetracking', flags: EffectFlags.REENTRANT },
		{ label: 'not reentrant, livetracking', flags: EffectFlags.LIVETRACKING },
		{
			label: 'reentrant, livetracking',
			flags: EffectFlags.REENTRANT | EffectFlags.LIVETRACKING,
		},
	])('cleanup ($label)', async ({ label, flags }) => {
		const v2 = ref(2)
		v2.id = 'v2'
		const v3 = ref(3)
		v3.id = 'v3'
		const v4 = ref(4)
		v4.id = 'v4'
		const v5 = ref(5)
		v5.id = 'v5'
		let wasCleanedUp1_Effect_0 = 0
		let wasCleanedUp1_Effect_1 = 0
		let wasCleanedUp_Section_0 = 0
		let wasCleanedUp_Section_1 = 0
		let wasCleanedUp_Section_2 = 0
		let wasCleanedUp_Effect_1_2 = 0
		let wasCleanedUp1_1_aborted = 0 as any
		let resourceX_defined = 0
		let isImmediateBranchCleanup = 1
		let wasCleanedUp_1_before_2_ = 0
		let visits_Root = 0
		let visits__0_ = 0
		let visits__1_ = 0
		let visits__2_ = 0

		var e = watchEffectAsyncLight(
			async function* (x: AsyncEffectHelper) {
				++visits_Root
				yield sleep(1)
				x.addEffectCleanup(aborted => {
					++wasCleanedUp1_Effect_0
					resourceX_defined = resourceX || 0
				}, true)
				x.addEffectCleanup(aborted => {
					++wasCleanedUp1_Effect_1
					wasCleanedUp1_1_aborted = aborted
				})

				var resourceX: any
				v2.value
				yield x.section('_0_', async function* () {
					++visits__0_
					x.addSectionCleanup(aborted => {
						++wasCleanedUp_Section_0
					}, isImmediateBranchCleanup)
					yield sleep(20)
					if (v3.value) {
						yield x.section('_1_', async function* () {
							++visits__1_
							x.addSectionCleanup(aborted => {
								++wasCleanedUp_Section_1
							}, isImmediateBranchCleanup)
							yield sleep(60)
							v4.value
						})
					}
					wasCleanedUp_1_before_2_ = wasCleanedUp_Section_1
					yield sleep(1)
					yield x.section('_2_', async function* () {
						++visits__2_
						x.addSectionCleanup(aborted => {
							++wasCleanedUp_Section_2
						}, isImmediateBranchCleanup)
						yield sleep(40)
						v5.value
						resourceX = 1
					})
				})
				x.addEffectCleanup(aborted => {
					++wasCleanedUp_Effect_1_2
				})
				yield sleep(40)
			},
			{
				flags:
					flags | EffectFlags.EnabledSections | EffectFlags.AbortRunOnRetrigger,
			},
		)

		await awaitCompletion(e)

		expect(e.runs.size).toBe(0)
		expect(visits_Root + visits__0_ + visits__1_ + visits__2_).toBe(4)
		expect(
			wasCleanedUp1_Effect_0 &&
			wasCleanedUp_Section_0 &&
			wasCleanedUp_Section_1 &&
			wasCleanedUp_Section_2 &&
			wasCleanedUp_1_before_2_ &&
			resourceX_defined,
		).toBeTruthy()
		expect(wasCleanedUp1_Effect_1 && wasCleanedUp_Effect_1_2).toBeFalsy()
		expect(wasCleanedUp1_1_aborted).toBeFalsy()

		++v4.value
		++v5.value
		expect(e.runs.size).toBe(0)
		await nextTick()
		expect(e.runs.size).toBe(1)
		expect(visits_Root + visits__0_ + visits__1_ + visits__2_).toBe(5)
		expect(visits__1_).toBe(2)
		expect(
			wasCleanedUp1_Effect_1 && wasCleanedUp_Effect_1_2,
			'cleaned up at start',
		).toBeTruthy()
		expect(
			wasCleanedUp1_Effect_0 +
			wasCleanedUp_Section_0 +
			wasCleanedUp_Section_1 +
			wasCleanedUp_Section_2,
			'not cleaned up at start',
		).toBe(4)
		await awaitCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(visits_Root + visits__0_ + visits__1_ + visits__2_).toBe(6)
		expect(visits__2_).toBe(2)
		expect(
			wasCleanedUp1_Effect_0 +
			wasCleanedUp_Section_0 +
			wasCleanedUp_Section_1 +
			wasCleanedUp_Section_2,
		).toBe(6)

		// branches, deferred
		isImmediateBranchCleanup = 0
		wasCleanedUp_Section_0 = wasCleanedUp_Section_1 = wasCleanedUp_Section_2 = 0
		++v2.value
		++v3.value
		++v4.value
		++v5.value
		expect(
			wasCleanedUp_Section_0 + wasCleanedUp_Section_1 + wasCleanedUp_Section_2,
		).toBe(0)
		await nextTick()
		expect(
			wasCleanedUp_Section_0 + wasCleanedUp_Section_1 + wasCleanedUp_Section_2,
		).toBe(0)
		expect(
			wasCleanedUp1_Effect_1 + wasCleanedUp_Effect_1_2,
			'cleaned up at start 2',
		).toBe(2)
		await awaitCompletion(e)
		expect(
			wasCleanedUp_Section_0 + wasCleanedUp_Section_1 + wasCleanedUp_Section_2,
		).toBe(0)

		isImmediateBranchCleanup = 1
		++v2.value
		++v3.value
		++v4.value
		++v5.value
		expect(
			wasCleanedUp_Section_0 + wasCleanedUp_Section_1 + wasCleanedUp_Section_2,
		).toBe(0)
		await awaitCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(
			wasCleanedUp_Section_0 + wasCleanedUp_Section_1 + wasCleanedUp_Section_2,
			'branches cleaned up at start and end',
		).toBe(6)
		expect(wasCleanedUp_Section_0, 'did not queue deferred cb').toBe(2)
		expect(wasCleanedUp_Section_1).toBe(2)
		expect(wasCleanedUp_Section_2).toBe(2)
		expect(wasCleanedUp_1_before_2_).toBe(2)

		// aborting
		async function abortTest(isManual: any, isFirstCall?: any) {
			wasCleanedUp_Section_0 =
				wasCleanedUp_Section_1 =
				wasCleanedUp_Section_2 =
				0
			wasCleanedUp1_Effect_0 =
				wasCleanedUp1_Effect_1 =
				wasCleanedUp_Effect_1_2 =
				0
			wasCleanedUp_1_before_2_ = 0
			resourceX_defined = 999
			++v2.value
			++v3.value
			++v4.value
			++v5.value
			await sleep_test(40)
			if (isManual) {
				expect(e.runs.size).toBe(1)
				e.abort()
				expect(e.runs.size).toBe(0)
			} else {
				expect(e.flags & EffectFlags.AbortRunOnRetrigger).toBe(
					EffectFlags.AbortRunOnRetrigger,
				)
				++v2.value
				expect(e.flags & EffectFlags.IsScheduledRun).toBe(
					EffectFlags.IsScheduledRun,
				)
			}
			expect(e.runs.size).toBe(0)
			if (isFirstCall) {
				expect(wasCleanedUp1_Effect_1, 'on start (deferred) + on abort').toBe(2)
				expect(
					wasCleanedUp_Effect_1_2,
					'on start only (deferred run-cleanup)',
				).toBe(1)
			} else {
				expect(
					wasCleanedUp1_Effect_1,
					'on abort (previous deferred cleanup was already called on previous abort)',
				).toBe(1)
				expect(wasCleanedUp_Effect_1_2, 'never reached due to abort').toBe(0)
			}
			expect(
				wasCleanedUp1_Effect_0 +
				wasCleanedUp_Section_0 +
				wasCleanedUp_Section_1,
				'on abort',
			).toBe(3)
			expect(
				wasCleanedUp_1_before_2_ + wasCleanedUp_Section_2 + resourceX_defined,
				'never reached due to abort',
			).toBe(0)

			if (!isManual) {
				// abort queued run
				await nextTick()
				e.abort()
			}
			await awaitCompletion(e)
			expect(e.runs.size).toBe(0)
			expect(
				e.flags &
				(EffectFlags.IsScheduledRun | EffectFlags.ScheduleRunAfterCurrentRun),
			).toBe(0)
		}
		// maual abort
		isImmediateBranchCleanup = 0
		await abortTest(true, true)
		isImmediateBranchCleanup = 1
		await abortTest(true)

		// auto abort
		isImmediateBranchCleanup = 0
		await abortTest(false)
		isImmediateBranchCleanup = 1
		await abortTest(false)
	})

	test('effect nesting', async () => {
		vi.useRealTimers() // ...

		async function awaitChildEffectCompletion(e: ReactiveEffectAsync) {
			await awaitCompletion(e)
			return Promise.all(e.children?.map(c => awaitCompletion(c, true)) || [])
		}

		const v2 = ref(2)
		const v3 = ref(3)
		const v4 = ref(4)
		const v5 = ref(5)
		const v6 = ref(6)
		const v7 = ref(7)
		const v8 = ref(8)
		const v9 = ref(9)
		var _v4 = 0
		var _v5 = 0
		var _v6 = 0
		var _v7 = 0
		var _v8 = 0 as any

		var _if = 1
		var e1: any, e2: any, en1: any, en2: any, en3: any
		var e_run = 0,
			e1_run = 0,
			e2_run = 0,
			en1_run = 0,
			en2_run = 0,
			en3_run = 0
		var first_e2: ReturnType<typeof watchEffectAsyncLight>
		var sequence: any[] = []
		var en1_runOnUpdate = 0

		var e = watchEffectAsyncLight(async function* (
			x: AsyncEffectHelperInterface,
		) {
			sequence.push('e')
			++e_run
			v2.value
			yield sleep(1)
			var v = v3.value + 10
			e1 = watchEffectAsyncLight(async function* (x) {
				sequence.push('e1')
				++e1_run
				yield sleep(1)
				yield sleep(50)
				_v4 = v4.value + v
			})
			yield sleep(1)

			if (_if) {
				en1 = watchEffectAsyncLight(
					'en1',
					async function* () {
						sequence.push('en1')
						++en1_run
						v9.v
						yield sleep(40)
						yield sleep(40)
						_v5 = v5.value + v
						yield sleep(40)
						_v5 += 1
					},
					{
						abortOldRunOnUpdate: 1,
						runOnUpdate: en1_runOnUpdate,
						flags: EffectFlags.AbortOnUnvisit,
					},
				)
				e2 = watchEffectAsyncLight(
					async function* () {
						sequence.push('e2')
						++e2_run
						yield sleep(40)
						yield sleep(40)
						_v6 = v6.value + e_run
						yield sleep(40)
						_v6 += 1
						v3.value
					},
					{ abortOldRunOnUpdate: 1, runOnUpdate: 0 },
				)
				if (!first_e2) first_e2 = e2
			} else {
				en2 = watchEffectAsyncLight(
					'en2',
					async function* () {
						sequence.push('en2')
						++en2_run
						yield sleep(40)
						yield sleep(40)
						_v7 = v7.value + v
						var y = 'y' + v

						en3 = watchEffectAsyncLight(
							'en3',
							async function* () {
								sequence.push('en3')
								++en3_run
								yield sleep(40)
								yield sleep(40)
								_v8 = v8.value + v + y
								yield sleep(40)
								v7.value
								_v8 += 1
							},
							{ abortOldRunOnUpdate: 0, runOnUpdate: 1 },
						)

						yield sleep(40)
						_v7 += 1
					},
					{
						abortOldRunOnUpdate: 0,
						runOnUpdate: 1,
						flags: EffectFlags.REENTRANT | EffectFlags.PersistentChildEffect,
					},
				)
			}

			yield sleep(25)
			v9.v
		})

		await awaitCompletion(e, 0, 40)
		expect(e1 && en1 && e2).toBeTruthy()
		expect(en2 || en3).toBeFalsy()
		expect(areEqual(e.children!, [e1, en1, e2])).toBeTruthy()
		expect(areEqual(e.getchildEffectIds(), ['', 'en1', ''])).toBeTruthy()
		expect(areEqual(e.getDeps(), [v2, v3, v9])).toBe(true)
		expect(e1!.runs.size + e2!.runs.size + en1!.runs.size).toBe(3)
		expect(areEqual(e1?.getDeps(), [])).toBe(true)
		expect(areEqual(e2?.getDeps(), [])).toBe(true)
		expect(areEqual(en1?.getDeps(), [])).toBe(true)
		expect(areEqual(sequence, ['e', 'e1', 'en1', 'e2'])).toBeTruthy()
		await awaitChildEffectCompletion(e)
		expect(e1!.runs.size + e2!.runs.size + en1!.runs.size).toBe(0)
		expect(areEqual(e1?.getDeps(), [v4])).toBe(true)
		expect(areEqual(e2?.getDeps(), [v6, v3])).toBe(true)
		expect(areEqual(en1?.getDeps(), [v9, v5])).toBe(true)

		sequence = []
		let e1_prev = e1 as any
		let en1_prev = en1 as any
		let e2_prev = e2 as any
		++v2.value
		await awaitCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(e1!.runs.size).toBe(1)
		expect(en1!.runs.size).toBe(0)
		expect(
			e2!.runs.size,
			'unnamed effects are always recreated and never updated',
		).toBe(1)
		expect(e1_prev === e1).toBeFalsy()
		expect(e2_prev === e2).toBeFalsy()
		expect(en1_prev === en1).toBeTruthy()
		expect(e1_prev.flags & EffectFlags.STOP).toBeTruthy()
		expect(e2_prev.flags & EffectFlags.STOP).toBeTruthy()
		expect(en1_prev.flags & EffectFlags.STOP).toBeFalsy()
		await awaitChildEffectCompletion(e)
		expect(e1!.runs.size + e2!.runs.size + en1!.runs.size).toBe(0)
		expect(areEqual(e.children!, [e1, en1, e2])).toBeTruthy()
		expect(areEqual(sequence, ['e', 'e1', 'e2'])).toBeTruthy()

		sequence = []
		++v5.value
		await nextTick()
		expect(e.runs.size + e1!.runs.size + e2!.runs.size).toBe(0)
		expect(en1!.runs.size).toBe(1)
		await en1!.awaitCompletion()
		expect(areEqual(sequence, ['en1'])).toBeTruthy()

		sequence = []
		++v6.value
		await nextTick()
		expect(e.runs.size + e1!.runs.size + en1!.runs.size).toBe(0)
		expect(e2!.runs.size).toBe(1)
		expect(areEqual(sequence, ['e2'])).toBeTruthy()
		await sleep_test(95)
		expect(_v6).toBe(9) // 7 + 2
		await e2!.awaitCompletion()
		expect(_v6).toBe(10)
		expect(e2!.runs.size).toBe(0)

		// expect non-persistent child to wait for its parent to init its execution if common dep trigger
		sequence = []
		expect(
			e.flags & (ReactiveFlags2.Dirty + e2!.flags) & ReactiveFlags2.Dirty,
		).toBe(0)
		++v3.value
		expect(
			(e.flags & ReactiveFlags2.Dirty) + (e2!.flags & ReactiveFlags2.Dirty),
		).toBe(ReactiveFlags2.Dirty * 2)
		await nextTick()
		expect(e.runs.size).toBe(1)
		expect(e2!.runs.size).toBe(0)
		await sleep_test(20)
		expect(e.runs.size).toBe(1)
		expect(e2!.runs.size).toBe(1)
		await e2!.awaitCompletion()
		expect(areEqual(sequence, ['e', 'e1', 'e2'])).toBeTruthy()
		expect(e.runs.size + e2!.runs.size).toBe(0)

		sequence = []
		expect(
			(e.flags & ReactiveFlags2.Dirty) + (en1!.flags & ReactiveFlags2.Dirty),
		).toBe(0)
		let _v9 = v9 as any
		if (_v9.subs.sub.effectId !== 'en1') {
			let s1 = _v9.subs
			let s2 = s1.nextSub
			s1.prevSub = s2
			s2.nextSub = s1
			s1.nextSub = undefined
			s2.prevSub = undefined
			s2.subsTail = s1
			_v9.subs = s2
		}
		expect(areEqual(_v9.getSubs(), [en1, e])).toBeTruthy()
		++v9.value
		expect(
			(e.flags & ReactiveFlags2.Dirty) + (en1!.flags & ReactiveFlags2.Dirty),
		).toBe(ReactiveFlags2.Dirty * 2)
		await nextTick()
		expect(e.runs.size).toBe(1)
		expect(en1!.runs.size).toBe(0)
		await sleep_test(20)
		expect(e.runs.size).toBe(1)
		expect(en1!.runs.size).toBe(1)
		await en1!.awaitCompletion()
		expect(areEqual(sequence, ['e', 'e1', 'en1', 'e2'])).toBeTruthy()
		expect(e.runs.size + en1!.runs.size).toBe(0)

		// abortOldRunOnUpdate
		sequence = []
		en1_runOnUpdate = 1
		++v5.value
		await nextTick()
		expect(e.runs.size).toBe(0)
		expect(en1!.runs.size).toBe(1)
		++v2.value
		await nextTick()
		expect(e.runs.size).toBe(1)
		expect(en1!.runs.size).toBe(1)
		en1_prev = en1 as any
		let en1_run_prev = getFirstKey(en1!.runs) as any
		await sleep_test(20)
		expect(e.runs.size).toBe(1)
		expect(en1!.runs.size).toBe(1)
		expect(en1_run_prev === getFirstKey(en1!.runs)).toBeFalsy()
		expect(en1_run_prev.flags & RunInfoFlags.Aborted).toBeTruthy()
		await awaitChildEffectCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(en1!.runs.size).toBe(0)
		expect(areEqual(sequence, ['en1', 'e', 'e1', 'en1', 'e2'])).toBeTruthy()
		expect(en1_prev === en1).toBeTruthy()

		// unnamed effects are stopped on parent run start
		sequence = []
		e1_prev = e1 as any
		++v4.value
		await nextTick()
		expect(e.runs.size).toBe(0)
		expect(e1!.runs.size).toBe(1)
		++v2.value
		await nextTick()
		expect(e.runs.size).toBe(1)
		expect(e1!.runs.size).toBe(1)
		await sleep_test(10)
		expect(e.runs.size).toBe(1)
		expect(e1!.runs.size).toBe(1)
		expect(e1_prev === e1).toBeFalsy()
		expect(e1_prev.flags & EffectFlags.STOP).toBeTruthy()
		await awaitChildEffectCompletion(e)
		expect(e.runs.size).toBe(0)
		expect(e1!.runs.size).toBe(0)

		// new children
		_if = 0
		en1_runOnUpdate = 0
		++v5.value
		await nextTick()
		expect(en1!.runs.size).toBe(1)
		en1_run_prev = getFirstKey(en1!.runs) as any
		++v2.value
		await awaitCompletion(e)
		expect(en1!.runs.size).toBe(0)
		expect(en1_run_prev.flags & RunInfoFlags.Aborted).toBeTruthy()
		expect(en1!.flags & EffectFlags.PausedOnUnvisit).toBeTruthy()
		expect(areEqual(e.children!, [e1, en2, en1])).toBeTruthy()
		expect(en2).toBeTruthy()
		expect(en3).toBe(undefined)
		expect(en2!.runs.size).toBe(1)
		await en2!.awaitCompletion()
		expect(areEqual(e.children!, [e1, en2, en1])).toBeTruthy()
		expect(areEqual(en2!.children!, [en3])).toBeTruthy()
		expect(en3!.runs.size).toBe(1)
		await en3!.awaitCompletion()
		expect(areEqual(en3!.getDeps(), [v8, v7])).toBe(true)

		// PauseOnUnvisit
		++v5.value
		await sleep_test(5)
		expect(
			e.runs.size +
			e1!.runs.size +
			en1!.runs.size +
			en2!.runs.size +
			en3!.runs.size,
		).toBe(0)

		sequence = []
		++v7.value
		await nextTick()
		expect(e.runs.size).toBe(0)
		expect(en2!.runs.size).toBe(1)
		expect(en3!.runs.size).toBe(0)
		await sleep_test(10)
		++v7.value
		await nextTick()
		expect(en2!.runs.size).toBe(2)
		expect(en3!.runs.size).toBe(0)
		await sleep_test(100)
		expect(en2!.runs.size).toBe(2)
		expect(en3!.runs.size).toBe(1)
		expect(en3!.flags & EffectFlags.ScheduleRunAfterCurrentRun).toBeTruthy()
		en3!.abort()
		await en2!.awaitCompletion(true)
		expect(en2!.runs.size).toBe(0)
		expect(en3!.runs.size).toBe(0)
		expect(areEqual(sequence, ['en2', 'en2', 'en3'])).toBeTruthy()

		++v8.value
		await nextTick()
		expect(en2!.runs.size).toBe(0)
		expect(en3!.runs.size).toBe(1)
		en3!.abort()

		_if = 1
		sequence = []
		++v2.value
		await awaitCompletion(e)
		expect(areEqual(e.children!, [e1, en1, e2, en2])).toBeTruthy()
		++v6.value
		await nextTick()
		expect(e2!.runs.size).toBe(1)
		e2!.abort()
		++v7.value
		await nextTick()
		expect(en2!.runs.size).toBe(1)
		expect(en3!.runs.size).toBe(0)
		en2!.abort(false)
		await nextTick()
		expect(
			en3!.runs.size,
			'temporarily paused dirty children are resumed on parent abort',
		).toBe(1)
		en3!.abort()

		expect(`An effectId is recommended for nested effects`).toHaveBeenWarned()
	})

})

