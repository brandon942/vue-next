import {
  ReactiveEffect,
  rootSectionID,
  SectionFlags,
  SectionInfo,
  type DebuggerEventExtraInfo,
  type ReactiveEffectAsync,
  type ReactiveEffectOptions,
} from './effect'
import { type Link, ReactiveFlags, type ReactiveNode } from './system'
import { Dep } from './dep'

export const triggerEventInfos: DebuggerEventExtraInfo[] = []

function iterateLinkedList(
  node: any,
  keyFirst: string,
  keyNext: string,
  linkTarget: string,
) {
  let a = []
  let link = node[keyFirst]
  let i = 0
  while (link) {
    if (++i > 200) {
      console.warn('possible linked list loop')
      break
    }
    a.push(link[linkTarget])
    link = link[keyNext]
  }
  return a
}
export function getSubs(node: ReactiveNode): ReactiveNode[] {
  // @ts-ignore
  node ??= this
  return iterateLinkedList(node, 'subs', 'nextSub', 'sub')
}
export function getDeps(node: ReactiveNode): ReactiveNode[] {
  // @ts-ignore
  node ??= this
  return iterateLinkedList(node, 'deps', 'nextDep', 'dep')
}
export function showSubs(dep: ReactiveNode): string[] {
  return getSubs(dep).map(b => {
    // @ts-ignore
    return `${b.ID ?? b.id} ${b.flags & ReactiveFlags.IsComputed ? ' (Computed)' : b.flags & ReactiveFlags.IsEffect ? '(e:ReactiveEffectAsyncffect)' : ''} ${b.flags & ReactiveFlags.DIRTY ? ' (DIRTY)' : ''}`
  })
}
export function showDeps(sub: ReactiveNode): string[] {
  return getDeps(sub).map(b => {
    // @ts-ignore
    return `${b.ID ?? b.id} ${b.flags & ReactiveFlags.IsComputed ? ' (Computed)' : (b as Dep).key ? `(Prop: "${(b as Dep).key}")` : '(Ref)'} ${b.flags & ReactiveFlags.DIRTY ? ' (DIRTY)' : ''}`
  })
}

export function getActiveDeps(e: ReactiveEffectAsync | SectionInfo): any {
  // @ts-ignore
  e ??= this
  return [...(e.activeDeps || [])]
}
export function getDeps2(
  e: ReactiveEffectAsync | SectionInfo | ReactiveEffect,
): any {
  // @ts-ignore
  e ??= this
  if ((e as ReactiveEffectAsync).rootSection) {
    return [...((e as ReactiveEffectAsync).activeDeps || [])]
  }
  // @ts-ignore
  let d = e.deps
  let a = []
  let i = 0
  while (d) {
    if (++i > 200) {
      console.warn('possible linked list loop')
      break
    }
    a.push(d.dep)
    d = d.nextDep
  }
  return a
}
export function getDeps3(e: ReactiveEffectAsync | ReactiveEffect): any {
  // @ts-ignore
  e ??= this
  return getDeps2(e).map((n: any) => n.id || n.ID || (n as Dep).key)
}
// @ts-ignore
export function getCollectedDeps(e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  let firstRun = e.runs.keys().next().value!
  return [...firstRun.collectedDeps]
}
// @ts-ignore
export function getDepLinks(e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  let links = getDepLinks2(e)
  return links.map(
    (d: Link) =>
      // @ts-ignore
      `d:{id:${d.dep.DepID ?? d.dep.id ?? d.dep.ID}, k:${(d.dep as Dep).key?.toString() || ''}}, linked:${d.tracking_Islinked}`,
  )
}
// @ts-ignore
export function getDepLinks2(e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  if (e.rootSection) {
    var deps = getDeps2(e)
    var links = []
    for (const d of deps) {
      let l = d.subs
      while (l) {
        if (l.sub === e) {
          links.push(l)
          break
        }
        l = l.nextSub
      }
    }
    return links
  } else {
    var links = []
    // @ts-ignore
    let d = e.deps
    let a = []
    let i = 0
    while (d) {
      if (++i > 200) {
        console.warn('possible dep linked list loop')
        break
      }
      // @ts-ignore
      a.push(d)
      d = d.nextDep
    }
    return a
  }
}
export function getDirtySections(e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  return e.sectionsAll
    ? [...e.sectionsAll]
        .filter(b => b[1].flags2 & SectionFlags.DIRTY && b[0] !== rootSectionID)
        .map(b => b[0])
    : []
}
// @ts-ignore
export function getSectionDeps(branchId: string, e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  return [...(e.sectionsAll?.get(branchId)?.activeDeps ?? [])]
}
// @ts-ignore
export function getSectionChildrenIds(
  branchId: string,
  e: ReactiveEffectAsync,
): any {
  // @ts-ignore
  e ??= this
  return (e.sectionsAll?.get(branchId)?.children ?? []).map(c => c.ID)
}
// @ts-ignore
export function getSectionInfos(e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  return [...(e.sectionsAll?.values() ?? [])].map(b => {
    // @ts-ignore
    return `${b.ID}: deps(${[...b.activeDeps].map(d => d.DepID ?? d.id).join(', ')})${b.flags2 & SectionFlags.DIRTY ? ' (DIRTY)' : ''} children(${b.children.map(c => c.ID).join(', ')})  ${b.parentSection ? ('parent: ' + b.parentSection?.ID ?? '') : ''}`
  })
}
// @ts-ignore
export function getchildEffectIds(e: ReactiveEffectAsync): any {
  // @ts-ignore
  e ??= this
  return [...(e.children ?? [])].map(c => c.effectId || '')
}
