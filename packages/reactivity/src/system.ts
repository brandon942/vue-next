// Ported from alien-signals. Diff against upstream main:
// https://github.com/stackblitz/alien-signals/compare/7e53655f40c3dd298168c278b3bf248a72f742d9...main
import type { ComputedRefImpl as Computed } from './computed.js'
import {
  AsyncRunInfo,
  EffectFlags,
  isCollected as isCollected,
  ReactiveEffectAsync,
  SectionInfo,
  type ReactiveEffect as Effect,
} from './effect.js'
import type { EffectScope } from './effectScope.js'
import { warn } from './warning.js'

export interface ReactiveNode {
  deps?: Link
  depsTail?: Link
  subs?: Link
  subsTail?: Link
  flags: ReactiveFlags
  activeSubLink?: Link
  activeRun?: AsyncRunInfo
  sections?: SectionInfo[]
  checkComputed?: ReactiveNode[]
  //   dev
  id?: string
  getSubs?: any
}

export interface Link {
  dep: ReactiveNode | Computed | Effect | EffectScope
  sub: ReactiveNode | Computed | Effect | EffectScope
  prevSub: Link | undefined
  nextSub: Link | undefined
  prevDep: Link | undefined
  nextDep: Link | undefined
  tracking_Islinked?: Boolean
  activeSubLinkPrev?: Link
  flags: LinkFlags
}

export const enum LinkFlags {
  None = 0,
  NOTIFIED = 1,
  TRACKED = 2,
  TO_CHECK_COMPUTED = 4,
}

export const enum ReactiveFlags {
  None = 0,
  IsMutable = 1 << 0,
  IsEffect = 1 << 1,
  IsComputed = 1 << 6,
  ActivelyRunning = 1 << 2,
  Recursed = 1 << 3,
  Dirty = 1 << 4,
  PendingNotification = 1 << 5,
  Computed_toNotify = 1 << 11,
  Computed_errored = 1 << 12,
  Computed_checkComputedDeps = 1 << 13,
  Dirty2 = 1 << 29,
}

const notifyBuffer: (Effect | undefined)[] = []

export let batchDepth = 0
export let activeSub: ReactiveNode | undefined = undefined

let globalVersion = 0
let notifyIndex = 0
let notifyBufferLength = 0

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  let prev = activeSub
  activeSub = sub
  return prev
}
export function getActiveSub(): ReactiveNode | undefined {
  return activeSub
}

export function startBatch(): void {
  ++batchDepth
}

export function endBatch(): void {
  if (!--batchDepth && notifyBufferLength) {
    flush()
  }
}

export function link(dep: ReactiveNode, sub: ReactiveNode): void {
  const asyncRun = sub.activeRun
  const sub_depsTail = asyncRun
    ? (sub as ReactiveEffectAsync).lastTrackedDepLink
    : sub.depsTail
  if (sub_depsTail !== undefined && sub_depsTail.dep === dep) {
    return
  }
  let nextDepLink: Link | undefined = undefined
  const recursedCheck = sub.flags & ReactiveFlags.ActivelyRunning
  if (recursedCheck) {
    nextDepLink = sub_depsTail !== undefined ? sub_depsTail.nextDep : sub.deps
    if (nextDepLink !== undefined && nextDepLink.dep === dep) {
      nextDepLink.tracking_Islinked = true
      if (asyncRun) {
        ;(sub as ReactiveEffectAsync).lastTrackedDepLink = nextDepLink
      }
      sub.depsTail = nextDepLink
      return
    }

    var activeLink = dep.activeSubLink
    if (activeLink?.sub === sub) {
      if (activeLink.tracking_Islinked) {
        return
      }
      activeLink.prevDep!.nextDep = activeLink.nextDep
      if (activeLink.nextDep) activeLink.nextDep.prevDep = activeLink.prevDep
      activeLink.prevDep = sub_depsTail
      activeLink.nextDep = nextDepLink
      activeLink.tracking_Islinked = true
      if (asyncRun) {
        ;(sub as ReactiveEffectAsync).lastTrackedDepLink = activeLink
      }
      sub.depsTail = activeLink
      if (nextDepLink !== undefined) {
        nextDepLink.prevDep = activeLink
      }
      if (sub_depsTail !== undefined) {
        sub_depsTail.nextDep = activeLink
      } else {
        sub.deps = activeLink
      }
      return
    }
  }
  const prevSub = dep.subsTail
  const newLink = (dep.subsTail = {
    flags: 0,
    dep,
    sub,
    prevDep: sub_depsTail,
    nextDep: nextDepLink,
    prevSub,
    nextSub: undefined,
    tracking_Islinked: true,
  }) as Link
  if (asyncRun) {
    ;(sub as ReactiveEffectAsync).lastTrackedDepLink = newLink
  }
  sub.depsTail = newLink
  if (sub === activeSub) {
    newLink.activeSubLinkPrev = dep.activeSubLink
    dep.activeSubLink = newLink
  }
  if (nextDepLink !== undefined) {
    nextDepLink.prevDep = newLink
  }
  if (sub_depsTail !== undefined) {
    sub_depsTail.nextDep = newLink
  } else {
    sub.deps = newLink
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = newLink
  } else {
    dep.subs = newLink
  }
}

export function unlink(
  link: Link,
  sub: ReactiveNode = link.sub,
): Link | undefined {
  if (!link.sub) {
    return link.nextDep
  }
  const dep = link.dep
  const prevDep = link.prevDep
  const nextDep = link.nextDep
  const nextSub = link.nextSub
  const prevSub = link.prevSub

  // once in old space, a removed link that still points into its lists would
  // keep younger links, and the effects behind them, alive across scavenges
  link.prevDep =
    link.nextDep =
    link.prevSub =
    link.nextSub =
    (link.sub as any) =
      undefined

  if (nextDep !== undefined) {
    nextDep.prevDep = prevDep
  } else {
    sub.depsTail = prevDep
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = nextDep
  } else {
    sub.deps = nextDep
  }
  if (nextSub !== undefined) {
    nextSub.prevSub = prevSub
  } else {
    dep.subsTail = prevSub
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = nextSub
  } else if (
    (dep.subs = nextSub) === undefined &&
    dep.flags & ReactiveFlags.IsMutable
  ) {
    // an unwatched computed releases its deps. An effect or a scope keeps
    // them until it stops: a scope may get here while its deps are stopping
    let toRemove = dep.deps
    if (toRemove !== undefined) {
      do {
        toRemove = unlink(toRemove, dep)
      } while (toRemove !== undefined)
      dep.flags |= ReactiveFlags.Dirty
    }
  }
  ;(dep as ReactiveNode).activeSubLink &&= undefined
  return nextDep
}

export function notifySubs(subsLink: Link, dirtyShallow?: any): void {
  let nextSubLink = subsLink.nextSub
  while (subsLink) {
    const sub = subsLink.sub
    let subFlags = sub.flags
    const subIsComplexEffect = subFlags & EffectFlags.ASYNC
    const depIsRefOrReactive = !(subsLink.dep.flags & ReactiveFlags.IsComputed)
    let toNotNotifyAndDirty

    if (subFlags & (ReactiveFlags.IsComputed | ReactiveFlags.IsEffect)) {
      if (subIsComplexEffect) {
        const effect = (sub as SectionInfo).effect ?? sub
        const effectFlags = effect.flags
        const REENTRANT = effectFlags & EffectFlags.REENTRANT
        if (
          !(subFlags & ReactiveFlags.PendingNotification) &&
          (REENTRANT ? true : !(subsLink.flags & LinkFlags.NOTIFIED))
        ) {
          // - By current design choice: Sub can be the effect OR a section within the effect
          const isRunning = effectFlags & EffectFlags.RUNNING
          toNotNotifyAndDirty = REENTRANT
            ? false
            : isRunning &&
              !isCollected(subsLink.dep, sub as ReactiveEffectAsync, effect)
          if (!toNotNotifyAndDirty) {
            if (
              isRunning &&
              !REENTRANT &&
              !(subFlags & ReactiveFlags.ActivelyRunning)
            ) {
              // The same Dep should be able to retrigger the effect so this flag is only set when the effect is running. Effect will hear from this Dep only once when running.
              // To allow outside changes of the same Dep to retrigger, do not set NOTIFIED if the Dep was changed in the Effect function
              // If REENTRANT then the same Dep can trigger parallel runs of the effect infinitely many times, so this flag doesn't matter
              subsLink.flags |= LinkFlags.NOTIFIED
            }
            subFlags |= ReactiveFlags.PendingNotification
            notifyBuffer[notifyBufferLength++] = sub as Effect
          }
        }
      } else {
        let subFlags2 = subFlags
        if (
          !(
            subFlags2 &
            (ReactiveFlags.ActivelyRunning |
              ReactiveFlags.Recursed |
              ReactiveFlags.Dirty |
              ReactiveFlags.PendingNotification)
          )
        ) {
          subFlags = subFlags2 | ReactiveFlags.PendingNotification
        } else if (
          !(
            subFlags2 &
            (ReactiveFlags.ActivelyRunning | ReactiveFlags.Recursed)
          )
        ) {
          if (!(subFlags2 & ReactiveFlags.PendingNotification)) {
            // Dirty on a Computed or Effect can be set before this function so Dirty should not prevent notification propagation
            subFlags |= ReactiveFlags.PendingNotification
          } else {
            subFlags2 = ReactiveFlags.None
          }
        } else if (!(subFlags2 & ReactiveFlags.ActivelyRunning)) {
          subFlags =
            (subFlags2 & ~ReactiveFlags.Recursed) |
            ReactiveFlags.PendingNotification
        } else if (
          !(
            subFlags2 &
            (ReactiveFlags.Dirty | ReactiveFlags.PendingNotification)
          ) &&
          sub.depsTail &&
          subsLink.tracking_Islinked
        ) {
          subFlags =
            subFlags2 |
            ReactiveFlags.Recursed |
            ReactiveFlags.PendingNotification

          // a computed that triggers itself does not notify
          subFlags2 =
            sub === activeSub || activeSub === undefined
              ? ReactiveFlags.None
              : subFlags & ReactiveFlags.IsMutable
        } else {
          toNotNotifyAndDirty = true
          subFlags2 = ReactiveFlags.None
        }

        if (subFlags2 & ReactiveFlags.IsEffect) {
          notifyBuffer[notifyBufferLength++] = sub as Effect
        }

        let subSubs
        if (
          subFlags2 & ReactiveFlags.IsMutable &&
          (subSubs = sub.subs) !== undefined
        ) {
          // notify upstream Effects: dep -> Computed1 -> Computed2 -> Effect
          sub.flags = subFlags
          notifySubs(subSubs)
        }
      }

      if (!(subFlags & ReactiveFlags.Dirty) && !toNotNotifyAndDirty) {
        if (depIsRefOrReactive) {
          if (
            dirtyShallow ||
            !(subFlags & EffectFlags.verifyThatDepsHaveChanged)
          ) {
            subFlags |= ReactiveFlags.Dirty
          } else {
            subFlags |= ReactiveFlags.Dirty2
          }
        } else {
          subsLink.flags |= LinkFlags.TO_CHECK_COMPUTED
        }
      }
      sub.flags = subFlags
    }

    if ((subsLink = nextSubLink!) !== undefined) {
      nextSubLink = subsLink.nextSub
      continue
    }
    break
  }
}

export function startTracking(
  sub: ReactiveNode,
  isAsyncSub?: any,
  toUnsetFlags: any = true,
): ReactiveNode | undefined {
  if (!isAsyncSub) {
    sub.depsTail = undefined
  }
  if (toUnsetFlags) {
    sub.flags =
      (sub.flags &
        ~(
          ReactiveFlags.Recursed |
          ReactiveFlags.Dirty |
          ReactiveFlags.Dirty2 |
          ReactiveFlags.PendingNotification |
          ReactiveFlags.Computed_checkComputedDeps
        )) |
      ReactiveFlags.ActivelyRunning
  } else {
    sub.flags |= ReactiveFlags.ActivelyRunning
  }

  let depLink = sub.deps
  while (depLink) {
    const dep = depLink.dep as ReactiveNode
    depLink.activeSubLinkPrev = dep.activeSubLink
    dep.activeSubLink = depLink
    depLink = depLink.nextDep
  }
  return setActiveSub(sub)
}

export function endTracking(
  sub: ReactiveNode,
  prevSub: ReactiveNode | undefined,
  isFinalEnd: boolean = true,
): void {
  if (__DEV__ && activeSub !== sub) {
    warn(
      'Active effect was not restored correctly - ' +
        'this is likely a Vue internal bug.',
    )
  }
  activeSub = prevSub
  if (!isFinalEnd) {
    let depLink = sub.deps
    while (depLink) {
      const dep = depLink.dep as ReactiveNode
      if (dep.activeSubLink) {
        dep.activeSubLink = depLink.activeSubLinkPrev
        depLink.activeSubLinkPrev = undefined
      }
      depLink = depLink.nextDep
    }
  } else {
    let depLink = sub.deps
    while (depLink) {
      const dep = depLink.dep as ReactiveNode
      if (dep.activeSubLink) {
        dep.activeSubLink = depLink.activeSubLinkPrev
        depLink.activeSubLinkPrev = undefined
      }
      depLink.tracking_Islinked = false
      depLink = depLink.nextDep
    }

    const depsTail = sub.depsTail
    let toRemove = depsTail !== undefined ? depsTail.nextDep : sub.deps
    while (toRemove !== undefined) {
      toRemove = unlink(toRemove, sub)
    }
  }

  const flags = (sub.flags &= ~ReactiveFlags.ActivelyRunning)
  if (flags & ReactiveFlags.Recursed) {
    markRecursed(sub)
  }
}

export function flush(): void {
  // a throwing subscriber must not abort the batch: keep notifying the rest,
  // reset the queue, then rethrow the first error once the batch is drained.
  let hasError = false
  let error: unknown
  while (notifyIndex < notifyBufferLength) {
    const sub = notifyBuffer[notifyIndex]!
    notifyBuffer[notifyIndex++] = undefined
    try {
      sub.notify()
    } catch (err) {
      if (!hasError) {
        hasError = true
        error = err
      }
    }
  }
  notifyBufferLength = 0
  notifyIndex = 0
  if (hasError) {
    throw error
  }
}

export function checkIfComputedDepsHaveChanged(subNode: ReactiveNode): boolean {
  try {
    return checkIfComputedDepsHaveChanged2(subNode)
  } catch (err) {
    markStale(subNode)
    throw err
  }
}
// A getter threw while checking `sub`, leaving the walk's nodes Pending, which
// later writes would take as already notified. Mark `sub` and every pending node
// below it stale instead: they re-evaluate on next read and still get notified.
function markStale(sub: ReactiveNode): void {
  const nodes = [sub]
  do {
    sub = nodes.pop()!
    sub.flags =
      (sub.flags & ~ReactiveFlags.PendingNotification) | ReactiveFlags.Dirty
    for (let link = sub.deps; link !== undefined; link = link.nextDep) {
      if (link.dep.flags & ReactiveFlags.PendingNotification) {
        nodes.push(link.dep)
      }
    }
  } while (nodes.length)
}
export function checkIfComputedDepsHaveChanged2(
  subNode: ReactiveNode,
): boolean {
  let stack: any[]
  let stackIndex = 0
  let checkDepth = 0
  let depsLink = subNode.deps!
  top: do {
    const dep = depsLink.dep
    const depFlags = dep.flags
    const subNodeFlags = subNode.flags
    let subNodeIsDirty = false

    if (subNodeFlags & ReactiveFlags.Dirty) {
      subNodeIsDirty = true
    } else {
      if (
        (depFlags & (ReactiveFlags.IsMutable | ReactiveFlags.Dirty)) ===
        (ReactiveFlags.IsMutable | ReactiveFlags.Dirty)
      ) {
        let subNode_prevDeps = subNode.deps
        if ((dep as Computed).update()) {
          const subs = dep.subs!
          if (subs != depsLink || subs.nextSub !== undefined) {
            shallowPropagateDirtinessToAllSubs(subs)
          } else {
            subs.flags &= ~(LinkFlags.TO_CHECK_COMPUTED | LinkFlags.NOTIFIED)
          }
          subNodeIsDirty = true
        }
        if (!subNode.deps && subNode_prevDeps) {
          if (!(subNode.flags & EffectFlags.STOP)) {
            subNodeIsDirty = true
          }
        }
      } else if (depsLink.flags & LinkFlags.TO_CHECK_COMPUTED) {
        depsLink.flags &= ~LinkFlags.TO_CHECK_COMPUTED
        stack ??= []
        stack[stackIndex++] = depsLink
        depsLink = dep.deps!
        subNode = dep
        ++checkDepth
        continue
      }
    }

    if (!subNodeIsDirty && depsLink.nextDep !== undefined) {
      depsLink = depsLink.nextDep
      continue
    }
    while (checkDepth) {
      --checkDepth
      depsLink = stack![--stackIndex]
      if (subNodeIsDirty) {
        const subs = subNode.subs!
        if ((subNode as Computed).update()) {
          if (subs != depsLink || subs.nextSub !== undefined) {
            shallowPropagateDirtinessToAllSubs(subs)
          } else {
            subs.flags &= ~(LinkFlags.TO_CHECK_COMPUTED | LinkFlags.NOTIFIED)
          }
          subNode = depsLink.sub
          continue
        }
      } else {
        subNode.flags &= ~(
          ReactiveFlags.PendingNotification |
          ReactiveFlags.Computed_checkComputedDeps
        )
      }
      subNode = depsLink.sub
      if (depsLink.nextDep !== undefined) {
        depsLink = depsLink.nextDep
        continue top
      }
      subNodeIsDirty = false
    }

    return subNodeIsDirty && !!subNode.flags
  } while (true)
}

export function shallowPropagateDirtinessToAllSubs(link: Link): void {
  do {
    const sub = link.sub
    const nextSub = link.nextSub
    let subFlags = sub.flags
    if (!(subFlags & ReactiveFlags.Dirty)) {
      link.flags &= ~LinkFlags.TO_CHECK_COMPUTED
      let isLinkNotYetTracked =
        link == (link.dep as ReactiveNode).activeSubLink &&
        !link.tracking_Islinked
      if (!isLinkNotYetTracked) {
        sub.flags = subFlags | ReactiveFlags.Dirty
        let subs
        if (subFlags & ReactiveFlags.IsComputed && (subs = sub.subs)) {
          makeNonDirtyComputedSubsCheckComputedDeps(subs)
        }
      }
    }
    link = nextSub!
  } while (link !== undefined)
}

export function shallowPropagateDirtinessToAllSubsSimple(link: Link): void {
  do {
    const sub = link.sub
    const nextSub = link.nextSub
    const subFlags = sub.flags
    if (
      (subFlags & (ReactiveFlags.PendingNotification | ReactiveFlags.Dirty)) ===
      ReactiveFlags.PendingNotification
    ) {
      sub.flags = subFlags | ReactiveFlags.Dirty
    }
    link = nextSub!
  } while (link !== undefined)
}

function makeNonDirtyComputedSubsCheckComputedDeps(link: Link) {
  do {
    const sub = link.sub
    const nextSub = link.nextSub
    let subFlags = sub.flags
    if (
      subFlags & ReactiveFlags.IsComputed &&
      !(
        subFlags &
        (ReactiveFlags.Dirty | ReactiveFlags.Computed_checkComputedDeps)
      )
    ) {
      link.flags &= ~LinkFlags.TO_CHECK_COMPUTED
      sub.flags = subFlags | ReactiveFlags.Computed_checkComputedDeps
      let subs = sub.subs
      if (subs) {
        makeNonDirtyComputedSubsCheckComputedDeps(subs)
      }
    }
    link = nextSub!
  } while (link !== undefined)
}

// A sub invalidated by its own run stays Pending | Recursed: it was not
// notified, and Recursed lets the next write through to it. The pending nodes
// below it would take that write as already notified, so mark them as well.
function markRecursed(sub: ReactiveNode): void {
  const nodes = [sub]
  do {
    sub = nodes.pop()!
    for (let link = sub.deps; link !== undefined; link = link.nextDep) {
      const dep = link.dep
      if (
        (dep.flags &
          (ReactiveFlags.Recursed | ReactiveFlags.PendingNotification)) ===
        ReactiveFlags.PendingNotification
      ) {
        dep.flags |= ReactiveFlags.Recursed
        nodes.push(dep)
      }
    }
  } while (nodes.length)
}
