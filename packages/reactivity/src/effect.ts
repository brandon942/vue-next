import { isFunction, NOOP } from '@vue/shared'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { setupOnTrigger } from './debug'
import { activeEffectScope } from './effectScope'
import {
  type Link,
  LinkFlags,
  ReactiveFlags,
  type ReactiveNode,
  activeSub,
  checkIfComputedDepsHaveChanged,
  endTracking,
  getActiveSub,
  link,
  setActiveSub,
  startTracking,
  unlink,
} from './system'
import { warn } from './warning'
import { Ref } from './ref'
import { Dep } from './dep'
import {
  getchildEffectIds,
  getCollectedDeps,
  getDepLinks,
  getDepLinks2,
  getDeps,
  getDeps2,
  getDeps3,
  getDirtySections,
  getSectionChildrenIds,
  getSectionDeps,
  getSectionInfos,
} from './testHelpers'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveNode
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  onStop?: () => void
  triggerSynchronously?: any
  deferInitialRun?: any
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export const enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  ALLOW_RECURSE = 1 << 7,
  PAUSED = 1 << 8,
  STOP = 1 << 9,
  verifyThatDepsHaveChanged = 1 << 10,
  // sync:
  HasDepConstraint = 1 << 16,

  // async:
  ASYNC = 1 << 11,
  REENTRANT = 1 << 12,
  LIVETRACKING = 1 << 13,
  RUNNING = 1 << 14,
  ScheduleRunAfterCurrentRun = 1 << 15,
  IsScheduledRun = 1 << 16,
  AbortRunOnRetrigger = 1 << 17,
  AbortRunOnPause = 1 << 18,
  AbortRunOnStop = 1 << 19,
  STATELESS = 1 << 20,
  EnabledSections = 1 << 21,
  TriggerSynchronously = 1 << 22,
  ScheduleRecursiveRerun = 1 << 23,
  ManualHandling = 1 << 24,
  StopEffectIfNoDeps = 1 << 25,
  // nested effects
  PersistentChildEffect = 1 << 26,
  PausedOnUnvisit = 1 << 27,
  AbortOnUnvisit = 1 << 28,
  // Unvisited = 1 << 29,

  Dirty2 = 1 << 29,
  // 1 << 29 should be the last flag if the number is to remain unboxed. (Keep flag values below 1,073,741,823)
}
export const enum EffectFlags_2 {
  None = 0,
  toForceScheduledRun = 1,
  // nested effects
  Unvisited = 1 << 1,
}

export class ReactiveEffect<T = any>
  implements ReactiveEffectOptions, ReactiveNode
{
  deps: Link | undefined = undefined
  depsTail: Link | undefined = undefined
  subs: Link | undefined = undefined
  subsTail: Link | undefined = undefined
  flags: number =
    ReactiveFlags.IsEffect |
    ReactiveFlags.Dirty |
    EffectFlags.TriggerSynchronously
  scheduledCb?: () => any
  scheduler?: EffectScheduler

  /**
   * @internal
   */
  cleanups: (() => void)[] | undefined = undefined
  /**
   * @internal
   */
  cleanupsLength = 0

  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  // @ts-expect-error
  fn(): T {}

  constructor(fn?: () => T) {
    if (fn !== undefined) {
      this.fn = fn
    }
    if (activeEffectScope) {
      link(this, activeEffectScope)
    }

    if (__DEV__ && activeSub) {
      console.error(`watchEffect() should never be used inside another effect `)
      // see: effect.specs.ts#'debug: the call sequence of onTrigger'
    }

    if (__TEST__) {
      // @ts-ignore
      this.EffectID = ++ReactiveEffectIdCtr
      // @ts-ignore
      this.getDeps = getDeps
      // @ts-ignore
      this.getDepLinks = getDepLinks
      // @ts-ignore
      this.getDepLinks2 = getDepLinks2
    }
  }

  get active(): boolean {
    return !(this.flags & EffectFlags.STOP)
  }

  /** @internal */
  get running(): boolean {
    return !!(this.flags & ReactiveFlags.ActivelyRunning)
  }

  pause(): void {
    this.flags |= EffectFlags.PAUSED
  }

  resume(): void {
    const flags = (this.flags &= ~EffectFlags.PAUSED)
    if (flags & (ReactiveFlags.Dirty | ReactiveFlags.PendingNotification)) {
      this.notify()
    }
  }

  notify(): void {
    const flags = this.flags
    if (!(flags & EffectFlags.PAUSED)) {
      if (flags & EffectFlags.TriggerSynchronously) {
        let scheduler = this.scheduler
        if (scheduler) {
          if (!(flags & EffectFlags.STOP)) {
            scheduler()
          }
        } else if (this.dirty) {
          this.run()
        }
      } else {
        if (flags & EffectFlags.IsScheduledRun) return
        this.flags |= EffectFlags.IsScheduledRun
        let scheduledCb = (this.scheduledCb ??= () => {
          let flags = this.flags
          if (!(flags & EffectFlags.IsScheduledRun)) {
            return
          }
          this.flags &= ~EffectFlags.IsScheduledRun
          if (!(flags & (EffectFlags.STOP | EffectFlags.PAUSED))) {
            if (this.dirty) {
              this.run()
            }
          }
        })
        queueMicrotask(scheduledCb)
      }
    }
  }

  run(): T {
    if (!this.active) {
      // - User manually runs the effect function (effect is stopped)
      // Q: Should an outer effect track reactives in this function when this effect is stopped?
      //   Currently it does. This is explicitly asserted in test:  effect.spec.ts#'stop: a stopped effect is nested in a normal effect'
      return this.fn()
    }
    cleanup(this)
    const prevSub = startTracking(this)
    try {
      return this.fn()
    } finally {
      endTracking(this, prevSub)
      const flags = this.flags
      if (
        (flags & (ReactiveFlags.Recursed | EffectFlags.ALLOW_RECURSE)) ===
        (ReactiveFlags.Recursed | EffectFlags.ALLOW_RECURSE)
      ) {
        this.flags = flags & ~ReactiveFlags.Recursed
        this.notify() // Checks if dirty, if yes reruns again until no longer dirty
      } else {
        // unlink effect if no deps so that it can be gc'd
        if (
          !this.deps &&
          flags & EffectFlags.StopEffectIfNoDeps &&
          !(flags & EffectFlags.ManualHandling)
        ) {
          this.stop()
        }
      }
    }
  }

  stop(): void {
    if (!this.active) {
      return
    }
    this.flags = EffectFlags.STOP
    let dep = this.deps
    while (dep !== undefined) {
      dep = unlink(dep, this)
    }
    const sub = this.subs
    if (sub !== undefined) {
      unlink(sub)
    }
    cleanup(this)
  }

  get dirty(): boolean {
    let flags = this.flags
    if (
      (flags &
        (EffectFlags.verifyThatDepsHaveChanged |
          ReactiveFlags.Dirty |
          ReactiveFlags.Dirty2)) ===
      ReactiveFlags.Dirty2
    ) {
      this.flags = flags |= ReactiveFlags.Dirty
    }
    if (flags & ReactiveFlags.Dirty) {
      return true
    }
    if (flags & ReactiveFlags.PendingNotification) {
      // a getter can stop or pause this effect during the check, so update
      // the current flags instead of writing back the ones read above
      if (checkIfComputedDepsHaveChanged(this)) {
        if (this.active) {
          // Apparently this is needed for Vapor components, they don't immediately startTracking so this flag sticks around and they rely on it to stick around
          this.flags |= ReactiveFlags.Dirty
        }
        return true
      } else {
        this.flags &= ~ReactiveFlags.PendingNotification
      }
    }
    return false
  }
}

if (__DEV__) {
  setupOnTrigger(ReactiveEffect)
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  var deferInitialRun
  const e = new ReactiveEffect(fn)
  if (options) {
    const { onStop, scheduler, triggerSynchronously } = options
    if (triggerSynchronously !== undefined && !triggerSynchronously) {
      e.flags &= ~EffectFlags.TriggerSynchronously
      if (options.deferInitialRun) {
        deferInitialRun = true
      }
    }
    if (onStop) {
      const stop = e.stop.bind(e)
      e.stop = () => {
        stop()
        onStop()
      }
    }
    if (scheduler) {
      e.scheduler = scheduler
    }
    if (__DEV__) {
      e.onTrack = options.onTrack
      e.onTrigger = options.onTrigger
    }
  }
  try {
    if (deferInitialRun) {
      e.notify()
    } else {
      e.run()
    }
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

const resetTrackingStack: (ReactiveNode | undefined)[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  resetTrackingStack.push(activeSub)
  setActiveSub()
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  const isPaused = activeSub === undefined
  if (!isPaused) {
    // Add the current active effect to the trackResetStack so it can be
    // restored by calling resetTracking.
    resetTrackingStack.push(activeSub)
  } else {
    // Add a placeholder to the trackResetStack so we can it can be popped
    // to restore the previous active effect.
    resetTrackingStack.push(undefined)
    for (let i = resetTrackingStack.length - 1; i >= 0; i--) {
      if (resetTrackingStack[i] !== undefined) {
        setActiveSub(resetTrackingStack[i])
        break
      }
    }
  }
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  if (__DEV__ && resetTrackingStack.length === 0) {
    warn(
      `resetTracking() was called when there was no active tracking ` +
        `to reset.`,
    )
  }
  if (resetTrackingStack.length) {
    setActiveSub(resetTrackingStack.pop()!)
  } else {
    setActiveSub()
  }
}

export function cleanup(
  sub: ReactiveNode & {
    cleanups: (() => void)[] | undefined
    cleanupsLength: number
  },
): void {
  const l = sub.cleanupsLength
  if (l) {
    const cleanups = sub.cleanups!
    for (let i = 0; i < l; i++) {
      cleanups[i]()
    }
    sub.cleanupsLength = 0
  }
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    const cleanups = (activeSub.cleanups ??= [])
    cleanups[activeSub.cleanupsLength++] = () => cleanupEffect(fn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(fn: () => void) {
  // run cleanup without active effect
  const prevSub = setActiveSub()
  try {
    fn()
  } finally {
    setActiveSub(prevSub)
  }
}

// EFFECT ASYNC ------------------------------------------------------------------------------------------------------------------------
// Helpers -------------------------------------------------------------------------------------------------------
export const getFirstKey = <K>(map: Map<K, any> | Set<K>): K | undefined =>
  map.keys().next().value
export const pushUnique = (a: any[], v: any): any =>
  a.indexOf(v) < 0 && a.push(v)
function pushUniqueOrMoveToEnd<T>(array: T[], value: T): any {
  const index = array.indexOf(value)
  let isNew
  if (index !== -1) {
    const len = array.length
    for (let i = index; i < len - 1; i++) {
      array[i] = array[i + 1]
    }
    array[len - 1] = value
  } else {
    array.push(value)
    isNew = true
  }
  return isNew
}

// Types ---------------------------------------------------------------------------------------------------------
export interface SubscriberAsync extends ReactiveNode {
  /** @internal */
  track(
    dep: ReactiveNode,
    section?: SectionInfo,
    reactiveObjectProxy?: object,
  ): any
  /** @internal */
  observedDeps?: Set<ReactiveNode>
}
export interface ReactiveEffectNestableInterface
  extends ReactiveNode, ReactiveEffectOptions {
  flags2: EffectFlags_2
  children?: Array<ReactiveEffectNestableInterface>
  parent?: ReactiveEffectNestableInterface
  effectId?: string
  fn: Function
  dirty: boolean
  whitelist?: WeakSet<ReactiveNode>
  blacklist?: WeakSet<ReactiveNode>
  addChild(child: ReactiveEffectNestableInterface): void
  stop(): void
  abort?(toIncludeChildren?: any): void
  pause(toIncludeChildren?: any): void
  resume(): any
  setConstraint(dependencies?: ListedDependencies, isBlacklist?: any): void
  scheduleRun(forceRun?: any, forceSync?: any): any
  awaitCompletion(toAwaitAll: any): Promise<any>
}

export const enum RunInfoFlags {
  Aborted = 1 << 0,
  Ended = 1 << 1,
  RunningInitialSyncPart = 1 << 2,
  Restarted = 1 << 3,
}
type CleanupHandler = (wasAborted: Boolean) => any

export interface AsyncEffectHelperInterface {
  resume<X>(something: X): X | undefined
  section(
    sectionID: String,
    func: (helper: AsyncEffectHelperInterface) => any,
    onSkippedCallback?: () => any,
  ): Promise<any>
  addEffectCleanup(fn: CleanupHandler, isCleanupImmediate?: any): void
  addSectionCleanup(fn: CleanupHandler, isCleanupImmediate?: any): void
  onRunStart(func: () => any): void
  onRunEnd(func: () => any): void
}
export type ListedDependencies =
  | ReactiveNode
  | Ref
  | Array<ReactiveNode | Ref | [obj: Record<any, any>, prop: string]>
  | ((...any: any) => any)
export type ListedDependenciesWithOther =
  | ListedDependencies
  | 'other'
  | Array<ReactiveNode | 'other' | Ref | [obj: Record<any, any>, prop: string]>

export type AsyncEffectFunction = (effectHelper: AsyncEffectHelper) => any
export const enum SectionFlags {
  DIRTY = 1 << 4,
  RUNNING = 1 << 13,
  VISITED = 1 << 1,
  NOSKIP = 1 << 5,
}

// Globals ----------------------------------------------------------------------------------------------------------
if (__TEST__) {
  var ReactiveEffectIdCtr = 0
}

// ------------------------------------------------------------------------------------------------------------------
// SECTIONS
export class SectionInfo implements ReactiveNode {
  constructor(public effect: ReactiveEffectAsync) {}
  id?: any
  ID?: string
  flags: ReactiveFlags =
    ReactiveFlags.IsEffect | ReactiveFlags.Dirty | EffectFlags.ASYNC
  flags2: SectionFlags = SectionFlags.DIRTY
  deps: Link | undefined = undefined
  depsTail: Link | undefined = undefined
  subs: Link | undefined = undefined
  subsTail: Link | undefined = undefined

  closure?: (...params: any) => any
  skippedCb?: () => any
  activeDeps: Set<ReactiveNode> = new Set()
  activeRun?: AsyncRunInfo
  collectingDeps_current?: Set<ReactiveNode> = undefined
  concurrentSectionRuns: number = 0
  parentSection?: SectionInfo
  children: SectionInfo[] = []
  deferredCleanups?: CleanupHandler[]
  lastTrackedDepLink?: Link = undefined
  depsLinkNotified?: boolean | Link = false

  notify(): any {
    if (!isDirty(this)) {
    } else {
      var sectionInfo: SectionInfo = this
      const isDirty = true
      if (isDirty) {
        let activeSection = sectionInfo.activeRun?.currentSection
        let toDirtySection = activeSection !== sectionInfo
        if (toDirtySection) {
          makeSectionDirty(sectionInfo)
          this.effect.flags |= ReactiveFlags.Dirty
        }
      }
    }
    this.flags &= ~(ReactiveFlags.Dirty | ReactiveFlags.PendingNotification)
    this.effect.notify(undefined, this)
  }
  track(dep: ReactiveNode): any {
    return this.effect.track(dep, this)
  }
}
type AsyncRunInfoSectionInfo = [
  hasFinished: boolean,
  collectingSectionChildren: SectionInfo[],
  immediateSectionCleanups: CleanupHandler[] | null,
  deferredSectionCleanups: CleanupHandler[] | null,
  collectingDeps: Set<ReactiveNode>,
]
const enum AsyncRunInfoSectionInfo_index {
  hasFinished = 0,
  collectingSectionChildren = 1,
  immediateSectionCleanups = 2,
  deferredSectionCleanups = 3,
  collectingDeps = 4,
}
async function section(
  sectionID: string,
  func: (helper: AsyncEffectHelper) => any,
  onSkippedCallback?: () => any,
  flags?: number,
): Promise<any>
async function section(
  sectionID: string,
  func: (...params: any) => any,
  onSkippedCallback?: () => any,
): Promise<any>
async function section(
  this: AsyncEffectHelper,
  _sectionID: string | Symbol | ((...params: any) => any),
  _func?: (...params: any) => any,
  skippedCb?: (...params: any) => any,
  sectionFlags: SectionFlags | number = 0,
): Promise<any> {
  const sectionID = _sectionID as string
  const func = _func
  const runInfo: AsyncRunInfo | undefined = this.effect.activeRun
  const invalid = !runInfo || activeSub?.activeRun !== runInfo
  if (invalid) {
    if (__DEV__) {
      warn(
        `section(${_sectionID}) was called outside of an effect context!`,
        `Make sure to change every 'await' to 'yield' inside of the effect.`,
      )
    }
    return
  }
  const effect = runInfo.effect
  var parentSection: SectionInfo | undefined = runInfo.currentSection
  let flags = effect.flags
  if (!(flags & EffectFlags.EnabledSections)) {
    return func!(runInfo.helper)
  }
  let sections: typeof effect.sectionsAll = effect.sectionsAll!
  let sectionInfo = sections!.get(sectionID)
  if (!sectionInfo) {
    sectionInfo = new SectionInfo(effect)
    if (__DEV__) {
      sectionInfo.ID = sectionID
      sectionInfo.flags2 |= sectionFlags
    }
    sections.set(sectionID, sectionInfo)
  }
  return visitSection(
    sectionInfo,
    runInfo,
    undefined,
    parentSection,
    undefined,
    func,
    skippedCb,
    true,
  )
}
async function visitSection(
  sectionInfo: SectionInfo,
  runInfo: AsyncRunInfo,
  caller_notification?: [hasFinished: Boolean | any],
  parentSection?: SectionInfo,
  parentSection_runInfo?: AsyncRunInfoSectionInfo,
  func?: (...params: any) => any,
  skippedCb?: (...params: any) => any,
  hasUpdatedParent?: any,
) {
  let hasChanges: any = sectionInfo.flags2 & SectionFlags.DIRTY
  const effect = runInfo.effect
  const runInfo_Sections = runInfo.Sections!
  const helper = runInfo.helper!
  const _func = func || sectionInfo.closure
  const effectFlags = effect.flags

  if (__DEV__ && sectionInfo.flags2 & SectionFlags.NOSKIP) {
    hasChanges = 1
  }
  if (parentSection) {
    if (!parentSection_runInfo) {
      let i = runInfo_Sections!.lastIndexOf(parentSection) + 1
      parentSection_runInfo = runInfo_Sections[i] as any
    }
    pushUniqueOrMoveToEnd(
      parentSection_runInfo![
        AsyncRunInfoSectionInfo_index.collectingSectionChildren
      ],
      sectionInfo,
    )
  }
  let run_sectionInfo: AsyncRunInfoSectionInfo
  let sectionRunInfoIndex = runInfo_Sections!.lastIndexOf(sectionInfo) + 1
  if (sectionRunInfoIndex <= 0) {
    var collectingSectionChildren = [] as SectionInfo[]
    run_sectionInfo = [
      false,
      collectingSectionChildren,
      null,
      null,
      new Set(),
    ] as AsyncRunInfoSectionInfo
    runInfo_Sections.push(sectionInfo, run_sectionInfo)
  } else {
    run_sectionInfo = runInfo_Sections![
      sectionRunInfoIndex
    ] as AsyncRunInfoSectionInfo
    if (!run_sectionInfo[AsyncRunInfoSectionInfo_index.hasFinished]) {
      throw new Error('effect sections should not call themselves recursively')
    }
    collectingSectionChildren =
      run_sectionInfo[AsyncRunInfoSectionInfo_index.collectingSectionChildren]
    collectingSectionChildren.length = 0
    run_sectionInfo[AsyncRunInfoSectionInfo_index.hasFinished] = false
  }

  let isLivetracking = effectFlags & EffectFlags.LIVETRACKING
  var awaited
  var error
  try {
    if (hasChanges) {
      let result: any
      sectionInfo.flags |= EffectFlags.RUNNING
      ++sectionInfo.concurrentSectionRuns
      let prevSection = runInfo.currentSection
      runInfo.currentSection = sectionInfo
      let collectingDeps =
        run_sectionInfo[AsyncRunInfoSectionInfo_index.collectingDeps]
      let collectingDeps_previous = sectionInfo.collectingDeps_current
      sectionInfo.collectingDeps_current = collectingDeps
      sectionInfo.flags2 &= ~SectionFlags.DIRTY
      var thrownError
      try {
        let deferredCleanups = sectionInfo.deferredCleanups
        if (deferredCleanups?.length) {
          let firstCleanupError = _cleanup(deferredCleanups)
          if (firstCleanupError !== undefined) {
            throw firstCleanupError
          }
        }
        sectionInfo.flags &= ~(
          ReactiveFlags.Recursed |
          ReactiveFlags.Dirty |
          ReactiveFlags.Dirty2 |
          ReactiveFlags.PendingNotification |
          EffectFlags.ScheduleRecursiveRerun
        )
        result = helperGenerator_handleFunction(_func, runInfo, false)
        if (result instanceof Promise) {
          awaited = true
          await result
        }
        let areChildSectionsFinished = true
        const isReentrant = effectFlags & EffectFlags.REENTRANT
        for (const child of collectingSectionChildren) {
          if (isReentrant) {
            let i = runInfo_Sections!.lastIndexOf(child) + 1
            let data = runInfo_Sections[i] as any
            if (!data[AsyncRunInfoSectionInfo_index.hasFinished]) {
              areChildSectionsFinished = false
              break
            }
          } else {
            if (child.flags & EffectFlags.RUNNING) {
              areChildSectionsFinished = false
              break
            }
          }
        }
        if (!areChildSectionsFinished) {
          throw new Error(
            'All child sections must finish before their parent section finishes. Make sure to `yield section()`.',
          )
        }

        if (!run_sectionInfo[AsyncRunInfoSectionInfo_index.hasFinished]) {
          sectionInfo.closure = _func
          sectionInfo.parentSection = parentSection
          sectionInfo.skippedCb = skippedCb
          let prevDeps = sectionInfo.activeDeps
          finalizeTracktingAndRemoveUnusedDeps(
            runInfo,
            sectionInfo,
            collectingDeps,
            true,
            isReentrant,
            isLivetracking,
          )
          run_sectionInfo[AsyncRunInfoSectionInfo_index.collectingDeps] =
            sectionInfo.collectingDeps_current = prevDeps

          let prevChildren = sectionInfo.children
          let prevChildrenLength = prevChildren.length
          sectionInfo.children = collectingSectionChildren
          for (const sec of collectingSectionChildren) {
            sec.flags2 |= SectionFlags.VISITED
          }
          run_sectionInfo[
            AsyncRunInfoSectionInfo_index.collectingSectionChildren
          ] = prevChildren

          if (prevChildrenLength) {
            let childOffset = 0
            for (let i = 0; i < prevChildrenLength; ++i) {
              let prevChild = prevChildren[i]
              if (prevChild.concurrentSectionRuns > 0) continue
              if (prevChild === collectingSectionChildren[childOffset]) {
                ++childOffset
                continue
              }
              let isInList =
                collectingSectionChildren.indexOf(prevChild, childOffset + 1) >=
                0
              if (!isInList) {
                prevChild.parentSection = undefined
                prevChild.flags2 &= ~SectionFlags.VISITED
              }
            }
          }

          let deferred =
            run_sectionInfo[
              AsyncRunInfoSectionInfo_index.deferredSectionCleanups
            ]
          if (deferred) {
            sectionInfo.deferredCleanups ??= []
            sectionInfo.deferredCleanups.push(...deferred)
            run_sectionInfo[
              AsyncRunInfoSectionInfo_index.deferredSectionCleanups
            ] = null
          }
        }
      } catch (err) {
        thrownError = err
        throw err
      } finally {
        if (!run_sectionInfo[AsyncRunInfoSectionInfo_index.hasFinished]) {
          let cleanupError = exitSection(
            sectionInfo,
            runInfo,
            runInfo.flags & RunInfoFlags.Aborted,
            run_sectionInfo,
            thrownError,
          )
          if (cleanupError && !thrownError) {
            throw cleanupError
          }
        }
        runInfo.currentSection = prevSection
        sectionInfo.collectingDeps_current = collectingDeps_previous
      }
    } else {
      skippedCb ||= sectionInfo.skippedCb
      let collected = runInfo.collectedDeps
      if (func) {
        sectionInfo.closure = func
      } else if (hasUpdatedParent && !(effectFlags & EffectFlags.STATELESS)) {
        sectionInfo.closure = undefined
      }

      for (const dep of sectionInfo.activeDeps) {
        if (isLivetracking) {
          link(dep, sectionInfo)
        }
        collected.add(dep)
      }

      let visitFinishedSync: any = caller_notification || []
      for (const child of sectionInfo.children) {
        visitFinishedSync[0] = undefined
        let result: any = visitSection(
          child,
          runInfo,
          visitFinishedSync,
          sectionInfo,
          run_sectionInfo,
          undefined,
          undefined,
          hasUpdatedParent,
        )
        let visitFinishedSync_result = visitFinishedSync[0]
        if (visitFinishedSync_result !== true) {
          awaited = true
          await result
        }
      }
    }
  } catch (err) {
    error = err
    throw err
  } finally {
    if (caller_notification) {
      caller_notification[0] = error === undefined ? true : error
    }
    run_sectionInfo[AsyncRunInfoSectionInfo_index.hasFinished] = true
  }

  if (!awaited) {
    effect.activeRun = runInfo
  }
  if (__DEV__ && skippedCb && !hasChanges) {
    skippedCb()
  }
}
function exitSection(
  sectionInfo: SectionInfo,
  runInfo: AsyncRunInfo,
  isAbort: any,
  sectionRunInfo: AsyncRunInfoSectionInfo,
  hasError?: any,
) {
  if (sectionRunInfo[AsyncRunInfoSectionInfo_index.hasFinished]) {
    return
  }
  sectionRunInfo[AsyncRunInfoSectionInfo_index.hasFinished] = true
  --sectionInfo.concurrentSectionRuns
  if (sectionInfo.concurrentSectionRuns <= 0) {
    sectionInfo.flags &= ~EffectFlags.RUNNING
    sectionInfo.lastTrackedDepLink = undefined
    sectionInfo.collectingDeps_current!.clear
    unsetDepLinkFlags(sectionInfo, LinkFlags.TRACKED | LinkFlags.NOTIFIED)
    if (__DEV__ && sectionInfo.concurrentSectionRuns < 0) {
      throw 'sectionInfo.concurrentSectionRuns < 0'
    }
  }

  var hasCleanupErrors
  let immediateSectionCleanups =
    sectionRunInfo[AsyncRunInfoSectionInfo_index.immediateSectionCleanups]
  if (immediateSectionCleanups) {
    hasCleanupErrors ||= _cleanup(immediateSectionCleanups as any, isAbort)
  }

  let interrupted = isAbort || hasError
  if (interrupted) {
    sectionInfo.lastTrackedDepLink = undefined
    let effectFlags = sectionInfo.effect.flags
    if (
      effectFlags & EffectFlags.LIVETRACKING &&
      !(effectFlags & EffectFlags.STOP)
    ) {
      const prevDirty = sectionInfo.flags & ReactiveFlags.Dirty
      const prevEffect = startTracking(sectionInfo)
      for (const dep of sectionInfo!.activeDeps) {
        link(dep, sectionInfo)
      }
      endTracking(sectionInfo, prevEffect)
      sectionInfo.flags |= prevDirty
    }
    sectionInfo.flags2 &= SectionFlags.DIRTY

    let deferredSectionCleanups =
      sectionRunInfo[AsyncRunInfoSectionInfo_index.deferredSectionCleanups]
    if (deferredSectionCleanups) {
      hasCleanupErrors ||= _cleanup(deferredSectionCleanups as any, interrupted)
    }
  }
  return hasCleanupErrors
}
function makeSectionDirty(sectionInfo: SectionInfo) {
  sectionInfo.flags2 |= SectionFlags.DIRTY
  const isSteteless = sectionInfo.effect.flags & EffectFlags.STATELESS
  if (isSteteless) {
    while ((sectionInfo = sectionInfo.parentSection!)) {
      if (sectionInfo.flags2 & SectionFlags.DIRTY) break
      sectionInfo.flags2 |= SectionFlags.DIRTY
    }
  } else {
    while (!sectionInfo.closure && (sectionInfo = sectionInfo.parentSection!)) {
      sectionInfo.flags2 |= SectionFlags.DIRTY
    }
  }
}
// RUN ------------------------------------------------------------------------------------------------------------------
export class AsyncRunInfo {
  public runId?: number
  constructor(
    public promise: Promise<any>,
    public resolver: (result?: any) => void,
    public effect: ReactiveEffectAsync,
  ) {
    if (effect.flags & EffectFlags.EnabledSections) {
      this.Sections = []
    }
  }
  collectedDeps: Set<ReactiveNode> = new Set()
  effectRunCleanups?: CleanupHandler[] = undefined
  deferredEffectCleanups?: CleanupHandler[] = undefined
  flags: RunInfoFlags = RunInfoFlags.RunningInitialSyncPart
  collectingChildEffects?: Array<ReactiveEffectNestableInterface>
  Sections?: (SectionInfo | AsyncRunInfoSectionInfo)[]
  currentSection?: SectionInfo
  lastSection?: SectionInfo
  helper?: AsyncEffectHelper
  runSequence?: any[]

  onRunStart?: (() => void) | null
  onRunEnd?: (() => void) | null
}
// HELPER - ASYNC-FUNCS -------------------------------------------------------------------------------------------
function addEffectCleanup(
  this: AsyncEffectHelper,
  fn: CleanupHandler,
  isCleanupImmediate?: any,
): void {
  const helper = this
  var runInfo: AsyncRunInfo = helper.effect.activeRun!
  const invalid = !runInfo || activeSub?.activeRun !== runInfo
  if (invalid) {
    if (__DEV__) {
      warn(
        `addEffectCleanup() was called outside of an effect context!`,
        `Make sure to change every 'await promise' to 'yield promise' inside of the Effect.`,
      )
    }
    return
  }

  if (runInfo.flags & RunInfoFlags.Ended) {
    return
  }
  if (isCleanupImmediate) {
    ;(runInfo.effectRunCleanups ??= []).push(fn)
  } else {
    ;(runInfo.deferredEffectCleanups ??= []).push(fn)
  }
}
function addSectionCleanup(
  this: AsyncEffectHelper,
  fn: CleanupHandler,
  isCleanupImmediate?: any,
): void {
  const helper = this
  var runInfo: AsyncRunInfo = helper.effect.activeRun!
  let section = runInfo?.currentSection
  const invalid = activeSub?.activeRun !== runInfo || !section
  if (invalid) {
    if (__DEV__) {
      warn(
        `addSectionCleanup() was called outside of an effect context!`,
        `Make sure to change every 'await promise' to 'yield promise' inside of the Effect.`,
      )
    }
    return
  }
  if (runInfo.flags & RunInfoFlags.Ended || !section) {
    return
  }
  let sectionRunInfoIndex = runInfo.Sections!.lastIndexOf(section) + 1
  let sectionData = runInfo.Sections![
    sectionRunInfoIndex
  ] as AsyncRunInfoSectionInfo
  let type = isCleanupImmediate
    ? AsyncRunInfoSectionInfo_index.immediateSectionCleanups
    : AsyncRunInfoSectionInfo_index.deferredSectionCleanups
  let cleanups = sectionData[type]
  if (!cleanups) {
    cleanups = sectionData[type] = []
  }
  cleanups.push(fn)
}

// HELPER -------------------------------------------------------------------------------------------
export class AsyncEffectHelper implements AsyncEffectHelperInterface {
  constructor(public effect: ReactiveEffectAsync) {}

  section: typeof section = section
  resume<X>(callback: X extends Promise<unknown> ? X : X): X
  resume<X extends (...args: never[]) => unknown>(callback: X): X
  resume<X>(callback: X): X {
    if (typeof callback !== 'function') {
      // Promise values are passed through.
      return callback
    }
    const runInfo: AsyncRunInfo = this.effect.activeRun!
    const invalid = !runInfo || activeSub?.activeRun !== runInfo
    if (invalid) {
      if (__DEV__) {
        warn(`resume() cannot be used outside of an effect context!`)
      }
      return callback
    }
    if (runInfo.flags & RunInfoFlags.Ended) {
      return callback
    }
    return helperGenerator_handleFunction(callback, runInfo, true)
  }

  addEffectCleanup: typeof addEffectCleanup = addEffectCleanup
  addSectionCleanup: typeof addSectionCleanup = addSectionCleanup

  onRunStart: typeof onRunStart = onRunStart
  onRunEnd: typeof onRunEnd = onRunEnd
}
function runAsyncWithGeneratorFunction(
  runInfo: AsyncRunInfo,
  generatorFunction: (...params: any) => any,
  ...args: any
) {
  const iterator = generatorFunction(runInfo.helper)
  var syncResult: [result: any, isDone: boolean] = [undefined, false]
  var p = new Promise((resolve, reject) => {
    iterateGeneratorFunctionIteration(
      runInfo,
      resolve,
      reject,
      iterator,
      syncResult,
    )
  })
  if (syncResult[1]) {
    return syncResult[0]
  }
  return p
}
async function iterateGeneratorFunctionIteration(
  runInfo: AsyncRunInfo,
  resolve: any,
  reject: any,
  iterator: any,
  syncResult?: any[],
) {
  var method = 'next'
  var value: any, valueRaw: any
  while (true) {
    if (runInfo.flags & (RunInfoFlags.Aborted | RunInfoFlags.Ended)) {
      return
    }
    let result
    try {
      result = runNodeWithTrackingContext(runInfo, () => {
        return iterator[method](valueRaw)
      })
      if (result instanceof Promise) {
        result = await result
      }
      value = result.value
    } catch (error) {
      reject(error)
      return
    }

    try {
      if (typeof value?.then === 'function') {
        valueRaw = await Promise.resolve(value)
      } else {
        valueRaw = value
      }
      method = 'next'
    } catch (error) {
      valueRaw = error
      method = 'throw'
      continue
    }
    const tag = valueRaw?.[Symbol.toStringTag]
    if (tag) {
      const isGeneratorIterator =
        tag === 'Generator' || tag === 'AsyncGenerator'
      if (isGeneratorIterator && 'next' in valueRaw) {
        try {
          valueRaw = await new Promise((resolve, reject) => {
            iterateGeneratorFunctionIteration(
              runInfo,
              resolve,
              reject,
              valueRaw,
            )
          })
        } catch (error) {
          valueRaw = error
          method = 'throw'
          continue
        }
      }
    }

    if (result.done) {
      resolve(valueRaw)
      if (syncResult) {
        syncResult[0] = valueRaw
        syncResult[1] = true
      }
      return
    }
  }
}
function runNodeWithTrackingContext(
  runInfo: AsyncRunInfo,
  callback: any,
  _this?: any,
) {
  const previous = activeSub
  const effect = runInfo.effect
  let currentSub = runInfo.currentSection ?? effect
  if (previous === currentSub) {
    return callback()
  }
  let isLivetracking = effect.flags & EffectFlags.LIVETRACKING
  if (isLivetracking) {
    startTracking(currentSub, true, false)
  } else {
    setActiveSub(currentSub)
    currentSub.flags |= ReactiveFlags.ActivelyRunning
  }
  currentSub.activeRun = runInfo
  effect.activeRun = runInfo
  try {
    return callback()
  } finally {
    if (isLivetracking) endTracking(currentSub, previous, false)
    else {
      setActiveSub(previous)
      currentSub.flags &= ~ReactiveFlags.ActivelyRunning
    }
    currentSub.activeRun = undefined
    effect.activeRun = undefined
  }
}
function helperGenerator_handleFunction(
  func: any,
  run: AsyncRunInfo,
  isCallback: any,
  toTrack: any = true,
) {
  const tag = (func as any)[Symbol.toStringTag]
  if (tag === 'AsyncFunction') {
    throw 'Async effects should not use async function handlers. Use generator functions.'
  }
  if (tag === 'GeneratorFunction' || tag === 'AsyncGeneratorFunction') {
    if (isCallback) {
      return function (this: unknown, ...args: any) {
        if (run.flags & (RunInfoFlags.Aborted | RunInfoFlags.Ended)) {
          return new Promise(NOOP)
        }
        return runAsyncWithGeneratorFunction(run, func as any)
      }
    } else {
      return runAsyncWithGeneratorFunction(run, func as any)
    }
  } else {
    if (isCallback) {
      return function (this: unknown, ...args: any) {
        if (run.flags & (RunInfoFlags.Aborted | RunInfoFlags.Ended)) {
          return new Promise(NOOP)
        }
        return runNodeWithTrackingContext(run, func)
      }
    } else {
      return runNodeWithTrackingContext(run, func)
    }
  }
}

// EFFECT -------------------------------------------------------------------------------------------
export const rootSectionID: symbol = Symbol()
export class ReactiveEffectAsync
  implements
    SubscriberAsync,
    ReactiveEffectOptions,
    ReactiveNode,
    ReactiveEffectNestableInterface
{
  runs: Set<AsyncRunInfo> = new Set()
  activeRun?: AsyncRunInfo = undefined
  maxConcurrentRuns: number = Infinity
  sectionsAll?: Map<string | symbol, SectionInfo> = undefined
  rootSections?: SectionInfo[]
  rootSection?: SectionInfo
  abortedRun?: AsyncRunInfo
  deferredCleanups?: CleanupHandler[]
  activeDeps?: Set<ReactiveNode>
  depsLinkNotified?: boolean | Link = false
  lastTrackedDepLink?: Link = undefined
  children?: Array<ReactiveEffectNestableInterface>
  parent?: ReactiveEffectNestableInterface
  private runIdCtr?: number
  scheduledCb?: () => any
  onBeforeStart?: (runPromise: Promise<any>) => any

  ID?: string // DEV
  getDeps?: any // DEV
  getDeps3?: any // DEV
  getCollectedDeps?: any // DEV
  getDepLinks?: any // DEV
  getDepLinks2?: any // DEV
  getDirtySections?: any // DEV
  getSectionDeps?: any // DEV
  getSectionChildrenIds?: any // DEV
  getSectionInfos?: any // DEV
  getchildEffectIds?: any // DEV

  whitelist?: WeakSet<ReactiveNode>
  blacklist?: WeakSet<ReactiveNode>

  /** deps-Head (Subscriber interface)
   * @internal
   */
  deps: Link | undefined = undefined
  depsTail: Link | undefined = undefined
  subs: Link | undefined = undefined
  subsTail: Link | undefined = undefined

  flags: ReactiveFlags =
    ReactiveFlags.IsEffect |
    ReactiveFlags.Dirty |
    EffectFlags.ASYNC |
    EffectFlags.StopEffectIfNoDeps
  flags2: EffectFlags_2 = EffectFlags_2.None
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  onRunStart?: () => void // only applicable if sections are enabled
  onRunEnd?: () => void

  constructor(
    public fn: AsyncEffectFunction,
    initialFlags: number = 0,
    public effectId?: string,
    isChildEffect?: any,
  ) {
    if (!isChildEffect && activeEffectScope) {
      link(this, activeEffectScope)
    }

    // Flag corrections
    if (
      (initialFlags &
        (EffectFlags.REENTRANT | EffectFlags.AbortRunOnRetrigger)) ===
      (EffectFlags.AbortRunOnRetrigger | EffectFlags.REENTRANT)
    ) {
      // cannot be REENTRANT if AbortRunOnRetrigger, REENTRANT is ignored in this case
      initialFlags &= ~EffectFlags.REENTRANT
    }

    // init
    this.flags |= initialFlags
    if (initialFlags & EffectFlags.EnabledSections) {
      this.sectionsAll = new Map()
      let rootSection = new SectionInfo(this)
      rootSection.closure = fn
      if (__TEST__) rootSection.ID = 'root'
      this.sectionsAll.set(rootSectionID, rootSection)
      this.rootSection = rootSection
    }

    if (__DEV__ && activeSub && activeSub instanceof ReactiveEffect) {
      // watchEffect() nesting not implemented
      warn(`watchEffectAsync() cannot be inside watchEffect() `)
    }

    if (__TEST__) {
      this.runIdCtr = 0
      // @ts-ignore
      this.EffectID = ++ReactiveEffectIdCtr
      this.getDeps = getDeps2
      this.getDeps3 = getDeps3
      this.getCollectedDeps = getCollectedDeps
      this.getDepLinks = getDepLinks
      this.getDepLinks2 = getDepLinks2
      this.getDirtySections = getDirtySections
      this.getSectionDeps = getSectionDeps
      this.getSectionChildrenIds = getSectionChildrenIds
      this.getSectionInfos = getSectionInfos
      this.getchildEffectIds = getchildEffectIds
    }
  }

  addChild(child: ReactiveEffectNestableInterface): void {
    let activeRun = activeSub?.activeRun
    if (!activeRun || activeRun.effect !== this) {
      throw 'effect.addChild(): invalid activeRun'
    }
    let children = (activeRun!.collectingChildEffects ??= [])
    pushUnique(children, child)
    child.parent = this
  }

  scheduleRun(forceRun?: any, forceSync?: any): any {
    if (forceSync) {
      this.flags &= ~(
        EffectFlags.ScheduleRunAfterCurrentRun |
        EffectFlags.ScheduleRecursiveRerun
      )
      this.run()
      return true
    }
    if (this.flags & EffectFlags.IsScheduledRun) return
    this.flags |= EffectFlags.IsScheduledRun
    if (forceRun) this.flags2 |= EffectFlags_2.toForceScheduledRun
    let scheduledCb = (this.scheduledCb ??= () => {
      let flags = this.flags
      if (!(flags & EffectFlags.IsScheduledRun)) {
        return
      }
      this.flags &= ~(
        EffectFlags.ScheduleRunAfterCurrentRun |
        EffectFlags.IsScheduledRun |
        EffectFlags.ScheduleRecursiveRerun
      )
      if (
        !(flags & (EffectFlags.STOP | EffectFlags.PAUSED)) &&
        (flags & EffectFlags.REENTRANT || !(flags & EffectFlags.RUNNING))
      ) {
        let dirty = this.dirty
        let forceRun = this.flags2 & EffectFlags_2.toForceScheduledRun
        if (forceRun) {
          this.flags2 &= ~EffectFlags_2.toForceScheduledRun
          this.run()
        } else if (dirty) {
          this.run()
        }
      }
    })
    queueMicrotask(scheduledCb)
    return true
  }

  abort(toIncludeChildren: any = true): void {
    this.flags &= ~(
      EffectFlags.ScheduleRunAfterCurrentRun |
      EffectFlags.ScheduleRecursiveRerun |
      EffectFlags.IsScheduledRun
    )
    abortRunsIfWanted(this, EffectFlags.RUNNING)
    if (toIncludeChildren) {
      let children = this.children
      if (children) {
        for (const child of children) {
          child.abort?.(toIncludeChildren)
        }
      }
    }
  }

  stop(): void {
    if (!(this.flags & EffectFlags.STOP)) {
      this.clearDependencies()
      const sub = this.subs
      if (sub !== undefined) {
        unlink(sub)
      }
      this.flags |= EffectFlags.STOP
      abortRunsIfWanted(this, EffectFlags.AbortRunOnStop)
      let children = this.children
      if (children) {
        for (const child of children) {
          child.stop()
        }
        children.length = 0
      }
    }
  }

  pause(toIncludeChildren: any = true): void {
    this.flags |= EffectFlags.PAUSED
    abortRunsIfWanted(this, EffectFlags.AbortRunOnPause)
    if (toIncludeChildren) {
      let children = this.children
      if (children) {
        for (const child of children) {
          child.pause(toIncludeChildren)
        }
      }
    }
  }

  resume(): any {
    let flags = this.flags
    if (flags & EffectFlags.PAUSED) {
      this.flags &= ~(EffectFlags.PAUSED | EffectFlags.PausedOnUnvisit)
      if (
        flags &
        (EffectFlags.IsScheduledRun |
          EffectFlags.ScheduleRunAfterCurrentRun |
          EffectFlags.ScheduleRecursiveRerun)
      ) {
        return true
      } else {
        if (flags & (ReactiveFlags.Dirty | ReactiveFlags.PendingNotification)) {
          return this.notify()
        }
      }
    }
  }
  get active(): boolean {
    return !(this.flags & EffectFlags.STOP)
  }

  private async _run(runInfo: AsyncRunInfo, rejecter: any): Promise<any> {
    let flags = this.flags
    let isLivetracking = flags & EffectFlags.LIVETRACKING
    let isReentrant = flags & EffectFlags.REENTRANT
    flags |= EffectFlags.RUNNING
    const EnabledSections = flags & EffectFlags.EnabledSections
    var helper = new AsyncEffectHelper(this)
    runInfo.helper = helper as AsyncEffectHelper

    var resultPromise
    var isError: any = false
    try {
      try {
        if (EnabledSections) {
          this.flags = flags
          const rootSection = this.rootSection!
          if (!(flags & EffectFlags.STATELESS)) {
            for (const section of this.sectionsAll!.values()) {
              if (!(section.flags2 & SectionFlags.DIRTY)) continue
              let highestDirty, hasUnchangedOnWay, hasUnchangedOnWay2
              let sec: SectionInfo | undefined = section
              while ((sec = sec.parentSection)) {
                if (sec.flags2 & SectionFlags.DIRTY) {
                  highestDirty = sec
                  if (hasUnchangedOnWay) {
                    hasUnchangedOnWay2 = true
                  }
                } else {
                  hasUnchangedOnWay = true
                }
              }
              if (highestDirty) {
                if (hasUnchangedOnWay2) {
                  sec = section
                  while ((sec = sec.parentSection)) {
                    sec.flags2 &= SectionFlags.DIRTY
                    if (sec === highestDirty) break
                  }
                }
                if (!highestDirty.closure) {
                  sec = highestDirty
                  while ((sec = sec.parentSection)) {
                    sec.flags2 &= SectionFlags.DIRTY
                    if (sec.closure) break
                  }
                }
              }
            }
          }

          if (rootSection.flags2 & SectionFlags.DIRTY) {
            this.onRunStart = this.onRunEnd = undefined
          }
          let runSections = () => {
            let visitFinished = [undefined] as any
            let resultPromise: Promise<any> | undefined = visitSection(
              rootSection!,
              runInfo,
              visitFinished,
            )
            let visitFinished_result = visitFinished[0]
            if (visitFinished_result !== undefined) {
              if (visitFinished_result !== true) {
                rejecter(visitFinished_result)
                isError = true
                resultPromise.catch(NOOP)
              }
              resultPromise = undefined
            }
            return resultPromise
          }
          runInfo.currentSection = rootSection
          runInfo.runSequence = [this.onRunStart, runSections, this.onRunEnd]
          resultPromise = runInSequence(runInfo)
        } else {
          flags =
            (flags &
              ~(
                ReactiveFlags.Recursed |
                ReactiveFlags.Dirty |
                ReactiveFlags.Dirty2 |
                ReactiveFlags.PendingNotification |
                EffectFlags.ScheduleRecursiveRerun
              )) |
            ReactiveFlags.ActivelyRunning
          this.flags = flags
          resultPromise = helperGenerator_handleFunction(
            this.fn,
            runInfo,
            false,
          )
        }
      } finally {
        runInfo.flags &= ~RunInfoFlags.RunningInitialSyncPart
      }
      if (runInfo.flags & RunInfoFlags.Aborted) {
        return
      }

      let isPromise = resultPromise instanceof Promise
      try {
        if (flags & EffectFlags.TriggerSynchronously && !isPromise) {
        } else {
          await resultPromise
          if (runInfo.flags & RunInfoFlags.Aborted) {
            return
          }
        }
      } finally {
      }

      if (!EnabledSections) {
        finalizeTracktingAndRemoveUnusedDeps(
          runInfo,
          this,
          runInfo.collectedDeps,
          EnabledSections,
          isReentrant,
          isLivetracking,
        )
      } else {
        this.activeDeps = runInfo.collectedDeps
      }
    } catch (err) {
      rejecter(err)
      isError = true
    } finally {
      endRun(this, runInfo, false, isError)
    }
  }
  run(): Promise<any> | void {
    this.flags &= ~EffectFlags.IsScheduledRun
    let { flags } = this
    let parent = this.parent
    if (
      parent &&
      parent.flags & (EffectFlags.IsScheduledRun | ReactiveFlags.Dirty) &&
      !(flags & EffectFlags.PersistentChildEffect)
    ) {
      return
    }

    if (
      this.runs.size >= this.maxConcurrentRuns ||
      (flags & EffectFlags.RUNNING && !(flags & EffectFlags.REENTRANT))
    ) {
      let firstRun = getFirstKey(this.runs)
      return firstRun!.promise!
    }
    if (flags & (EffectFlags.STOP | EffectFlags.ScheduleRunAfterCurrentRun)) {
      return
    }

    let resolver: any
    let rejecter: any
    let runPromise
    let abortedRun = this.abortedRun
    if (abortedRun) {
      this.abortedRun = undefined
      resolver = abortedRun.resolver
      runPromise = abortedRun.promise
    } else {
      runPromise = new Promise(
        (resolve, reject) => ((resolver = resolve), (rejecter = reject)),
      )
      let onBeforeStart = this.onBeforeStart
      if (onBeforeStart) {
        onBeforeStart(runPromise)
      }
    }

    let deferredCleanups = this.deferredCleanups
    if (deferredCleanups) {
      let firstError = _cleanup(deferredCleanups, false)
      if (firstError) {
        throw firstError
      }
    }

    let runInfo = new AsyncRunInfo(runPromise, resolver, this)
    if (__DEV__) {
      runInfo.runId = ++this.runIdCtr!
    }

    if (abortedRun) {
      runInfo.flags |= RunInfoFlags.Restarted
    }

    prepareChildrenOnParentRun(this)
    this.runs.add(runInfo)
    this._run(runInfo, rejecter)
    return runPromise
  }

  /**
   * @internal
   */
  notify(dep?: ReactiveNode, section?: SectionInfo): any {
    const flags = this.flags
    let sub
    if (section) {
      sub = section
    } else {
      sub = this
      sub.flags &= ~ReactiveFlags.PendingNotification
    }
    try {
      if (
        flags &
        (EffectFlags.PAUSED | EffectFlags.IsScheduledRun | EffectFlags.STOP)
      ) {
        return
      }
      if (!(flags & EffectFlags.EnabledSections) && !isDirty(this)) {
        return
      }
      if (true) {
        let running = flags & EffectFlags.RUNNING
        if (running) {
          const REENTRANT = flags & EffectFlags.REENTRANT
          let activeRun = (activeSub as ReactiveEffectAsync)?.activeRun
          if (activeRun?.effect === this) {
            let isRunningSyncPartAndRecursionIsAllowed =
              activeRun.flags & RunInfoFlags.RunningInitialSyncPart &&
              (flags &
                (EffectFlags.ALLOW_RECURSE |
                  EffectFlags.TriggerSynchronously)) ===
                (EffectFlags.ALLOW_RECURSE |
                  EffectFlags.TriggerSynchronously) &&
              !REENTRANT &&
              !(flags & EffectFlags.ScheduleRunAfterCurrentRun)
            if (isRunningSyncPartAndRecursionIsAllowed) {
              this.flags |= EffectFlags.ScheduleRecursiveRerun
              if (section) {
                makeSectionDirty(section)
              }
              return
            } else {
              return
            }
          }
        }
      }
      return this.trigger()
    } finally {
    }
  }

  private trigger(toForce?: any): any {
    let flags = this.flags
    if (flags & EffectFlags.RUNNING && !(flags & EffectFlags.REENTRANT)) {
      this.flags |= EffectFlags.ScheduleRunAfterCurrentRun
      abortRunsIfWanted(this, EffectFlags.AbortRunOnRetrigger)
    } else {
      return this.scheduleRun(toForce, flags & EffectFlags.TriggerSynchronously)
    }
  }

  /**
   * @internal
   */
  track(dep: ReactiveNode, section?: SectionInfo): any {
    var { flags } = this
    if (flags & EffectFlags.STOP) {
      return false
    } else {
      var toTrack = true
      var constraint
      if ((constraint = this.blacklist)) {
        toTrack = !constraint.has(dep)
      } else if ((constraint = this.whitelist)) {
        toTrack = constraint.has(dep)
      }
      if (toTrack) {
        const sub = section ?? this
        if (flags & EffectFlags.LIVETRACKING) {
          link(dep, sub)
        }
        let run = sub.activeRun!
        let collected = run.collectedDeps
        collected.add(dep)
        if (section) {
          section.collectingDeps_current!.add(dep)
        }
      }
      return toTrack
    }
  }

  get dirty(): boolean {
    return isDirty(this)
  }

  async awaitCompletion(toAwaitAll: any = false): Promise<any> {
    var result
    while (true) {
      if (this.flags & EffectFlags.IsScheduledRun) {
        await null
        continue
      }
      let num = this.runs.size
      if (!num) {
        return Promise.resolve(result)
      }
      if (num > 1) {
        if (toAwaitAll) {
          await Promise.all([...this.runs].map(x => x.promise))
        } else {
          return Promise.race([...this.runs].map(x => x.promise))
        }
      } else {
        result = await getFirstKey(this.runs)?.promise
      }
    }
  }

  setConstraint(
    dependencies?: ListedDependencies,
    isBlacklist: any = true,
  ): void {
    setConstraint(this, dependencies, isBlacklist)
  }

  clearDependencies(): void {
    if (this.flags & EffectFlags.RUNNING) {
      return
    }
    let depLink = this.deps
    while (depLink !== undefined) {
      depLink = unlink(depLink, this)
    }
    this.activeDeps?.clear()
    let branches = this.sectionsAll
    if (branches) {
      for (const section of branches.values()) {
        section.activeDeps.clear()
        let depLink = section.deps
        while (depLink !== undefined) {
          depLink = unlink(depLink, this)
        }
      }
    }
  }
}

function endRun(
  effect: ReactiveEffectAsync,
  run: AsyncRunInfo,
  aborted?: Boolean,
  isError?: any,
): void {
  if (run) {
    try {
      if (run.flags & (RunInfoFlags.Ended | RunInfoFlags.Aborted)) {
        return
      }
      let flags = effect.flags
      var isScheduledReRunOnAbort
      if (aborted) {
        run.flags |= RunInfoFlags.Aborted
      }
      run.flags |= RunInfoFlags.Ended
      effect.runs.delete(run)

      const wasInterrupted = aborted || isError
      let EnabledSections = flags & EffectFlags.EnabledSections
      let isLivetracking = flags & EffectFlags.LIVETRACKING
      if (isLivetracking) {
        if (wasInterrupted) {
          let depLink = effect.deps
          while (depLink) {
            depLink.tracking_Islinked = false
            depLink = depLink.nextDep
          }
        }
      }
      if (!effect.runs.size || wasInterrupted) {
        effect.lastTrackedDepLink = undefined
        unsetDepLinkFlags(effect, LinkFlags.TRACKED | LinkFlags.NOTIFIED)
      }

      let hasCleanupErrors: any
      if (aborted) {
        if (EnabledSections) {
          let infos = run.Sections!
          let hasFinishedSections
          for (let i = infos.length - 2; i >= 0; i -= 2) {
            let sectionInfo = infos[i] as SectionInfo
            let sectionRunInfo = infos[i + 1] as AsyncRunInfoSectionInfo
            if (!sectionRunInfo[AsyncRunInfoSectionInfo_index.hasFinished]) {
              exitSection(sectionInfo, run, aborted, sectionRunInfo)
            } else {
              hasFinishedSections = true
            }
          }
        } else {
          if (isLivetracking && !(flags & EffectFlags.STOP)) {
            let lastActiveDeps = effect.activeDeps ?? []
            const prevEffect = startTracking(effect)
            for (const dep of lastActiveDeps) {
              link(dep, effect)
            }
            endTracking(effect, prevEffect)
          }
        }
      }

      hasCleanupErrors ||= _cleanup(run.effectRunCleanups, aborted)
      let deferred = run.deferredEffectCleanups
      if (deferred?.length) {
        if (aborted || flags & EffectFlags.STOP) {
          hasCleanupErrors ||= _cleanup(deferred, aborted)
        } else {
          ;(effect.deferredCleanups ??= []).push(...deferred)
        }
      }

      if (hasCleanupErrors) {
        effect.flags = flags &= ~(
          EffectFlags.ScheduleRecursiveRerun |
          EffectFlags.ScheduleRunAfterCurrentRun
        )
      }
      var toRecurse: any = flags & EffectFlags.ScheduleRecursiveRerun
      if (toRecurse) {
        effect.flags =
          (effect.flags &
            ~(
              EffectFlags.ScheduleRunAfterCurrentRun |
              EffectFlags.ScheduleRecursiveRerun
            )) |
          ReactiveFlags.PendingNotification
        if (effect.dirty) {
          effect.abortedRun = run
        } else {
          toRecurse = false
        }
      }

      if (!effect.runs.size) {
        effect.flags &= ~EffectFlags.RUNNING
        if (!toRecurse && flags & EffectFlags.ScheduleRunAfterCurrentRun) {
          effect.scheduleRun(true)
          const ScheduledNewRunOnAbort =
            EffectFlags.AbortRunOnRetrigger |
            EffectFlags.ScheduleRunAfterCurrentRun
          if (
            aborted &&
            (flags & ScheduledNewRunOnAbort) === ScheduledNewRunOnAbort
          ) {
            isScheduledReRunOnAbort = true
            effect.abortedRun = run
          }
        }
      }

      if (
        EnabledSections &&
        !(wasInterrupted || flags & EffectFlags.STATELESS)
      ) {
        if (run.onRunStart) {
          effect.onRunStart = run.onRunStart
        }
        if (run.onRunEnd) {
          effect.onRunEnd = run.onRunEnd
        }
      }

      if (run.collectingChildEffects || effect.children) {
        updateChildEffects(aborted, effect, run.collectingChildEffects)
      }

      if (toRecurse) {
        effect.run()
      } else {
        let numDeps = (effect.rootSection ?? effect).activeDeps?.size
        if (
          !numDeps &&
          flags & EffectFlags.StopEffectIfNoDeps &&
          !(flags & EffectFlags.ManualHandling) &&
          !effect.runs.size &&
          !(effect.flags & EffectFlags.IsScheduledRun)
        ) {
          effect.stop()
        }
      }
    } finally {
      if (!isScheduledReRunOnAbort && !toRecurse) {
        run.resolver!()
      }
    }
  }
}
function abortRunsIfWanted(
  effect: ReactiveEffectAsync,
  eventFlag: number,
): Boolean {
  let flag_runningAbortOnEvent = EffectFlags.RUNNING | eventFlag
  if ((effect.flags & flag_runningAbortOnEvent) === flag_runningAbortOnEvent) {
    for (const run of effect.runs) {
      endRun(effect, run, true)
    }
    return true
  }
  return false
}

function finalizeTracktingAndRemoveUnusedDeps(
  runInfo: AsyncRunInfo,
  sub: ReactiveEffectAsync | SectionInfo,
  collectedDeps: Set<ReactiveNode>,
  EnabledSections: any,
  isReentrant: any,
  isLivetracking: any,
) {
  let effect = runInfo.effect
  let numDepsCollected = collectedDeps.size
  if (numDepsCollected && !isLivetracking) {
    if (!(effect.flags & EffectFlags.STOP)) {
      const prevEffect = startTracking(sub, false, false)
      for (const dep of collectedDeps) {
        link(dep, sub)
      }
      endTracking(sub, prevEffect)
      sub.activeDeps = collectedDeps
    }
  } else {
    sub.activeDeps = collectedDeps
    const lastTrackedDepLink = sub.lastTrackedDepLink
    sub.depsTail = lastTrackedDepLink
    let toRemove =
      lastTrackedDepLink !== undefined ? lastTrackedDepLink.nextDep : sub.deps
    let depLink = sub.deps
    while (depLink) {
      depLink.tracking_Islinked = false
      depLink = depLink.nextDep
    }

    if (isReentrant) {
      while (toRemove !== undefined) {
        let isDepCollectedByARun = false
        const dep = toRemove.dep
        for (const run of effect.runs) {
          if (run.collectedDeps.has(dep)) {
            isDepCollectedByARun = true
            break
          }
        }
        if (isDepCollectedByARun) {
          toRemove = toRemove.nextDep
        } else {
          toRemove = unlink(toRemove, sub)
        }
      }
    } else {
      while (toRemove !== undefined) {
        toRemove = unlink(toRemove, sub)
      }
    }
  }
}

function unsetDepLinkFlags(
  sub: ReactiveEffectAsync | SectionInfo,
  flags: number,
) {
  let depLink = sub.deps
  while (depLink) {
    depLink.flags &= ~flags
    depLink = depLink.nextDep
  }
}
function isDirty(sub: ReactiveEffectAsync | SectionInfo) {
  let flags = sub.flags
  if (
    (flags &
      (EffectFlags.verifyThatDepsHaveChanged |
        ReactiveFlags.Dirty |
        ReactiveFlags.Dirty2)) ===
    ReactiveFlags.Dirty2
  ) {
    sub.flags = flags |= ReactiveFlags.Dirty
  }
  if (flags & ReactiveFlags.Dirty) {
    return true
  }
  if (flags & ReactiveFlags.PendingNotification) {
    if (checkIfComputedDepsHaveChanged(sub)) {
      sub.flags = flags | ReactiveFlags.Dirty
      return true
    } else {
      sub.flags = flags & ~ReactiveFlags.PendingNotification
    }
  }
  return false
}

export function isCollected(
  dep: ReactiveNode,
  sub: ReactiveEffectAsync | SectionInfo,
  effect: ReactiveEffectAsync,
): any {
  const flags = effect.flags
  if (flags & EffectFlags.RUNNING) {
    if (flags & EffectFlags.REENTRANT) {
      return true
    }
    const collected = (sub.activeRun || getFirstKey(effect.runs))!.collectedDeps
    return collected.has(dep)
  }
  return false
}
function onRunStart(this: AsyncEffectHelper, func?: (() => any) | any): void {
  return onRunHook(this.effect, func, true)
}
function onRunEnd(this: AsyncEffectHelper, func?: (() => any) | any): void {
  return onRunHook(this.effect, func, false)
}
function onRunHook(
  effect: ReactiveEffectAsync,
  func: (() => any) | any,
  isStart: any,
): void {
  const run = effect.activeRun!
  const section = run?.currentSection
  if (section && section !== effect.rootSection) {
    return
  }
  const isFunction_ = isFunction(func)
  run[isStart ? 'onRunStart' : 'onRunEnd'] = isFunction_
    ? () => untracked(func)
    : null
  if (isFunction_) {
    if (isStart) {
      return helperGenerator_handleFunction(func, run, false)
    } else {
      run.runSequence![2] = func
    }
  }
}
function runInSequence(run: AsyncRunInfo, index: number = 0): any {
  let seq = run.runSequence!
  for (let i = index; i < seq.length; i++) {
    let func = seq[i]
    let result = func && helperGenerator_handleFunction(func, run, false)
    if (result instanceof Promise) {
      return result.then(resolved => {
        return runInSequence(run, i + 1)
      })
    }
  }
}
export function getCurrentHelper(): AsyncEffectHelperInterface | undefined {
  let effect = activeSub
  if (effect && effect.flags & EffectFlags.ASYNC) {
    return effect.activeRun?.helper
  }
}
const _cleanup = (
  cleanups: CleanupHandler[] | undefined,
  aborted: any = false,
): any => {
  let firstError
  if (cleanups?.length) {
    const prevSub = setActiveSub()
    for (var i = cleanups.length - 1; i >= 0; --i) {
      var cleanup = cleanups[i]
      try {
        cleanup(aborted)
      } catch (error) {
        firstError ??= error
        if (typeof globalThis.reportError === 'function') {
          globalThis.reportError(error)
        } else {
          if (__DEV__) {
            console.error('Unhandled error in cleanup:', error)
          } else {
            console.error(error)
          }
        }
      }
    }
    cleanups.length = 0
    setActiveSub(prevSub)
  }
  return firstError
}
export const setConstraint = (
  effect: ReactiveEffectNestableInterface,
  dependencies?: ListedDependencies,
  isBlacklist: any = true,
): void => {
  let depConstraint: any = dependencies
    ? observeDependenciesIn(dependencies)
    : null
  depConstraint = depConstraint?.size ? new WeakSet(depConstraint) : null
  if (isBlacklist) {
    effect.blacklist = depConstraint
    effect.whitelist = undefined
  } else {
    effect.blacklist = undefined
    effect.whitelist = depConstraint
  }
}

export function observeDependenciesIn(
  dependencies: ListedDependencies,
  includeReactiveObjectsArray?: any[],
): Set<ReactiveNode> {
  let observedDeps = (ObservingSubscriber.observedDeps =
    new Set<ReactiveNode>())
  if (includeReactiveObjectsArray) {
    ObservingSubscriber.observedReacitveObjects = includeReactiveObjectsArray
  }
  const prevEffect = setActiveSub(ObservingSubscriber as any)
  try {
    if (Array.isArray(dependencies)) {
      for (let i = 0; i < dependencies.length; i++) {
        let ref = dependencies[i]
        if (Array.isArray(ref)) {
          // reactive object
          let [obj, prop] = ref
          obj[prop]
        } else {
          // @ts-ignore
          ref.value
        }
      }
    } else if (typeof dependencies === 'function') {
      dependencies()
    } else if (dependencies instanceof Dep) {
      observedDeps.add(dependencies)
    } else {
      // @ts-ignore
      dependencies.value
    }
  } finally {
    setActiveSub(prevEffect)
    ObservingSubscriber.observedDeps = null
    if (includeReactiveObjectsArray) {
      ObservingSubscriber.observedReacitveObjects = null
    }
  }
  return observedDeps
}
export const ObservingSubscriber = {
  flags: EffectFlags.ASYNC as EffectFlags,
  observedDeps: null as Set<ReactiveNode> | null,
  observedReacitveObjects: null as any[] | null,
  track(dep: ReactiveNode, _?: any, reactiveObject?: any) {
    let { observedDeps, observedReacitveObjects } = this
    let size = observedDeps!.size
    observedDeps!.add(dep)
    if (observedDeps!.size > size && observedReacitveObjects) {
      observedReacitveObjects.push(reactiveObject)
    }
    return false
  },
}
export function untracked(func: () => any): void {
  let effect = activeSub
  if (!effect) {
    return func()
  }
  let run = effect.activeRun
  let flags = effect.flags
  let isLivetracking = run && flags & EffectFlags.LIVETRACKING
  if (isLivetracking) endTracking(effect, undefined, false)
  else setActiveSub()
  try {
    return func()
  } finally {
    if (isLivetracking) startTracking(effect, true)
    else setActiveSub(effect)
  }
}

// NESTED EFFECTS -------------------------------------------------------------------------------------------
export const prepareChildrenOnParentRun = (
  effect: ReactiveEffectNestableInterface,
): void => {
  let children = effect.children
  if (children) {
    for (let i = children.length - 1; i >= 0; --i) {
      let child = children[i]
      if (!child.effectId) {
        child.stop()
        children.splice(i, 1)
      } else {
        pauseOnUnvisit(child, true, false)
      }
    }
  }
}

export const updateChildEffects = (
  aborted: any,
  effect: ReactiveEffectNestableInterface,
  collectingChildEffects: typeof effect.children,
): void => {
  let children = effect.children
  let childI = 0,
    childrenLen = children?.length ?? 0,
    collectingChildrenLen = collectingChildEffects?.length ?? 0
  if (aborted) {
    // stop and remove new children
    for (let i = 0; i < collectingChildrenLen; i++) {
      let collectedChild = collectingChildEffects![i]
      let hasChild =
        childrenLen > childI
          ? collectedChild === children![childI]
            ? (++childI, true)
            : children!.indexOf(collectedChild, childI + 1) >= 0
          : false
      if (!hasChild) {
        collectedChild.stop()
      }
    }
    // resume temporarily paused non-persistent children
    for (let i = 0; i < childrenLen; i++) {
      let child = children![i]
      resumeOnVisit(child, true)
    }
    return
  } else {
    for (let i = 0; i < childrenLen; i++) {
      let child = children![i]
      let isCollected =
        collectingChildrenLen > childI
          ? child === collectingChildEffects![childI]
            ? (++childI, true)
            : collectingChildEffects!.indexOf(child, childI + 1) >= 0
          : false
      let childFlags = child.flags
      if (!isCollected) {
        child.flags2 |= EffectFlags_2.Unvisited
        if (
          (childFlags &
            (EffectFlags.RUNNING |
              EffectFlags.ASYNC |
              EffectFlags.AbortOnUnvisit)) ===
          (EffectFlags.RUNNING | EffectFlags.ASYNC | EffectFlags.AbortOnUnvisit)
        ) {
          child.abort!()
        }
        if (!(childFlags & EffectFlags.STOP)) {
          pauseOnUnvisit(child, true, true)
          ;(collectingChildEffects ??= []).push(child)
        }
      }
    }
  }
  effect.children = collectingChildEffects
}
const pauseOnUnvisit = (
  child: ReactiveEffectNestableInterface,
  toIncludeChildren: any = true,
  allowAbort?: any,
): void => {
  if (
    !(child.flags & (EffectFlags.PersistentChildEffect | EffectFlags.STOP)) &&
    !(child.flags2 & EffectFlags_2.Unvisited)
  ) {
    child.flags |= EffectFlags.PAUSED | EffectFlags.PausedOnUnvisit
    if (allowAbort) {
      abortRunsIfWanted(
        child as ReactiveEffectAsync,
        EffectFlags.AbortRunOnPause,
      )
    }
    if (toIncludeChildren) {
      let children = child.children
      if (children) {
        for (const child of children) {
          pauseOnUnvisit(child, toIncludeChildren)
        }
      }
    }
  }
}
const resumeOnVisit = (
  child: ReactiveEffectNestableInterface,
  toIncludeChildren: any = true,
): void => {
  if (
    child.flags & EffectFlags.PausedOnUnvisit &&
    !(child.flags & EffectFlags.STOP) &&
    !(child.flags2 & EffectFlags_2.Unvisited)
  ) {
    child.resume()
    if (toIncludeChildren) {
      let children = child.children
      if (children) {
        for (const child of children) {
          resumeOnVisit(child, toIncludeChildren)
        }
      }
    }
  }
}
