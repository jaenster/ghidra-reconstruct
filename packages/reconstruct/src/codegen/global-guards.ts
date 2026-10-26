/**
 * Guard zones between globals, for the loud build.
 *
 * A global Ghidra typed too small is written or read past its end, and the damage
 * shows up far away: the v1736 health-bar table was written 512 bytes into a
 * 2-byte object and surfaced as a crash in RtlLeaveCriticalSection. Every data
 * definition the generator emits is followed by one guard macro naming it:
 *
 *   int gnMonsterHealthBarRow = 0; D2_GLOBAL_GUARD(gnMonsterHealthBarRow, "gnMonsterHealthBarRow");
 *
 * The guard goes on the definition's last line, so no line of the tree moves:
 * __LINE__ (D2_ALLOC, D2_FREE) and the debug line table stay what they were.
 *
 * In a normal build every guard macro expands to nothing - the line is an empty
 * declaration or statement - so the tree compiles to the same objects as without
 * them. The parser reads the line as a MacroDecl (cpp-parser DECLARATION_MACROS),
 * so the lint and every later pass see the definitions around it intact. With REDIVIVUS_LOUD_GUARDS (the loud build)
 * each one is a 32-byte pattern placed directly after its owner, plus a
 * {owner, size, guard, name} entry in the `.d2grd$m` section that the loud
 * runtime walks (support/d2_loud.cpp).
 *
 * The guard lands in the owner's section only if it has the owner's linkage and
 * initialisation: GCC emits an external datum in place but a `static` zero-filled
 * one through `.lcomm`, which the assembler places after every in-place datum.
 * Hence four spellings:
 *
 *   D2_GLOBAL_GUARD / D2_GLOBAL_GUARD_BSS   owner has external linkage
 *   D2_STATIC_GUARD / D2_STATIC_GUARD_BSS   owner is `static` (file-local or function-local)
 *
 * `_BSS` is for an owner with no initializer. An owner WITH one still lands in .bss
 * when its initializer is not a constant (a static constructor, or a function-local
 * static's first-call init with its 8-byte guard variable after it), so the two
 * initialised forms also lay down a second, zero-filled guard; the runtime keeps
 * whichever of the two sits closest after the owner. The loud build also compiles with
 * -fno-toplevel-reorder (definitions keep source order) and
 * -fno-zero-initialized-in-bss (an all-zero initializer stays in .data with its
 * pattern-filled guard).
 */

export type GuardLinkage = 'external' | 'static';

/** The guard line that follows a data definition. */
export function globalGuardLine(
  name: string,
  qualifiedName: string,
  linkage: GuardLinkage,
  initialized: boolean,
): string {
  const macro = `D2_${linkage === 'static' ? 'STATIC' : 'GLOBAL'}_GUARD${initialized ? '' : '_BSS'}`;
  return `${macro}(${name}, "${qualifiedName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}");`;
}

/** The qualified name a guard reports: `Ns::Inner::name`, or `name` at root scope. */
export function guardQualifiedName(scope: string | undefined | null, name: string): string {
  return scope ? `${scope}::${name}` : name;
}

/** The definition carries an initializer, the same test `globalDefinition` renders by. */
export function hasDefinitionInitializer(g: { initializedData?: unknown; isInitialized?: boolean }): boolean {
  return !!g.initializedData || !!g.isInitialized;
}

/**
 * The macro definitions, for the platform header every translation unit includes
 * first. Empty in a normal build.
 */
export function globalGuardMacroLines(): string[] {
  const fill = Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? '0xA5' : '0xD2')).join(',');
  return [
    '// Guard zones between globals (the loud build; see support/d2_loud.cpp). The generator',
    '// emits one of these after every data definition; without REDIVIVUS_LOUD_GUARDS they are',
    '// empty. The fill reads as 0xD2A5D2A5: negative as any signed width, a kernel-half pointer.',
    '#ifdef REDIVIVUS_LOUD_GUARDS',
    '#include <type_traits>',
    'struct D2GuardEntry {',
    '  const void* pOwner;',
    '  uint32_t nOwnerSize;',
    '  const unsigned char* pGuard;',
    '  const char* pszName;',
    '};',
    'typedef unsigned char D2GuardBytes[32];',
    `#define D2_GUARD_FILL {${fill}}`,
    '#define D2_GUARD_TYPE(ident) std::conditional<std::is_const<std::remove_all_extents<decltype(ident)>::type>::value, const D2GuardBytes, D2GuardBytes>::type',
    '#define D2_GUARD_ENTRY(ident, qname) static const D2GuardEntry d2guardent_##ident __attribute__((used, section(".d2grd$m"))) = { (const void*)&ident, (uint32_t)sizeof(ident), d2guard_##ident, qname }',
    '#define D2_GUARD_ENTRY_Z(ident, qname) static const D2GuardEntry d2guardentz_##ident __attribute__((used, section(".d2grd$m"))) = { (const void*)&ident, (uint32_t)sizeof(ident), d2guardz_##ident, qname }',
    '#define D2_GLOBAL_GUARD(ident, qname) extern D2_GUARD_TYPE(ident) d2guard_##ident; D2_GUARD_TYPE(ident) d2guard_##ident __attribute__((used, aligned(1))) = D2_GUARD_FILL; D2_GUARD_ENTRY(ident, qname); D2GuardBytes d2guardz_##ident __attribute__((used, aligned(1))); D2_GUARD_ENTRY_Z(ident, qname)',
    '#define D2_GLOBAL_GUARD_BSS(ident, qname) D2GuardBytes d2guard_##ident __attribute__((used, aligned(1))); D2_GUARD_ENTRY(ident, qname)',
    '#define D2_STATIC_GUARD(ident, qname) static D2_GUARD_TYPE(ident) d2guard_##ident __attribute__((used, aligned(1))) = D2_GUARD_FILL; D2_GUARD_ENTRY(ident, qname); static D2GuardBytes d2guardz_##ident __attribute__((used, aligned(1))); D2_GUARD_ENTRY_Z(ident, qname)',
    '#define D2_STATIC_GUARD_BSS(ident, qname) static D2GuardBytes d2guard_##ident __attribute__((used, aligned(1))); D2_GUARD_ENTRY(ident, qname)',
    '#else',
    '#define D2_GLOBAL_GUARD(ident, qname)',
    '#define D2_GLOBAL_GUARD_BSS(ident, qname)',
    '#define D2_STATIC_GUARD(ident, qname)',
    '#define D2_STATIC_GUARD_BSS(ident, qname)',
    '#endif',
  ];
}
