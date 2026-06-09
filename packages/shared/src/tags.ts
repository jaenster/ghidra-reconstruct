/**
 * Utility functions for working with structured symbol tags
 */

import { SymbolTag, TAG_TYPES, METHOD_MODIFIERS } from './protocol.js';

/**
 * Create a structured tag
 */
export function createTag(type: string, data?: string): SymbolTag {
  const tag: SymbolTag = { type };
  if (data !== undefined) {
    tag.data = data;
  }
  return tag;
}

/**
 * Create a method tag with class name and optional modifier
 */
export function createMethodTag(className: string, modifier?: string): SymbolTag {
  const data = modifier ? `${className},${modifier}` : className;
  return createTag(TAG_TYPES.METHOD, data);
}

/**
 * Create a static method tag with class name
 */
export function createStaticMethodTag(className: string): SymbolTag {
  return createMethodTag(className, METHOD_MODIFIERS.STATIC);
}

/**
 * Create a not-method tag (explicitly marks function as NOT a method)
 */
export function createNotMethodTag(): SymbolTag {
  return createTag(TAG_TYPES.NOT_METHOD);
}

/**
 * Create a vtable tag with class name
 */
export function createVTableTag(className: string): SymbolTag {
  return createTag(TAG_TYPES.VTABLE, className);
}

/**
 * Create a constructor tag with class name
 */
export function createConstructorTag(className: string): SymbolTag {
  return createMethodTag(className, METHOD_MODIFIERS.CONSTRUCTOR);
}

/**
 * Create a destructor tag with class name
 */
export function createDestructorTag(className: string): SymbolTag {
  return createMethodTag(className, METHOD_MODIFIERS.DESTRUCTOR);
}

/**
 * Create a noreturn tag
 */
export function createNoReturnTag(): SymbolTag {
  return createTag(TAG_TYPES.NORETURN);
}

/**
 * Create an inline tag
 */
export function createInlineTag(): SymbolTag {
  return createTag(TAG_TYPES.INLINE);
}

/**
 * Create a varargs tag
 */
export function createVarargsTag(): SymbolTag {
  return createTag(TAG_TYPES.VARARGS);
}

/**
 * Create a pure function tag (no side effects)
 */
export function createPureTag(): SymbolTag {
  return createTag(TAG_TYPES.PURE);
}

/**
 * Create a leaf function tag (doesn't call other functions)
 */
export function createLeafTag(): SymbolTag {
  return createTag(TAG_TYPES.LEAF);
}

/**
 * Parse a tag from "type:data" or "type" string format
 */
export function parseTagString(tagString: string): SymbolTag {
  const colonIdx = tagString.indexOf(':');
  if (colonIdx > 0) {
    return {
      type: tagString.substring(0, colonIdx),
      data: tagString.substring(colonIdx + 1),
    };
  }
  return { type: tagString };
}

/**
 * Format a tag to "type:data" or "type" string format
 */
export function formatTagString(tag: SymbolTag): string {
  return tag.data ? `${tag.type}:${tag.data}` : tag.type;
}

/**
 * Check if a tag matches a specific type
 */
export function isTagType(tag: SymbolTag, type: string): boolean {
  return tag.type === type;
}

/**
 * Check if a tag is a method tag (any kind — instance, static, ctor, dtor)
 */
export function isMethodTag(tag: SymbolTag): boolean {
  return tag.type === TAG_TYPES.METHOD;
}

/**
 * Check if a method tag has a specific modifier
 */
export function hasMethodModifier(tag: SymbolTag, modifier: string): boolean {
  if (!isMethodTag(tag) || !tag.data) return false;
  const parts = tag.data.split(',');
  return parts.length > 1 && parts[1] === modifier;
}

/**
 * Check if a tag is a static method tag
 */
export function isStaticMethodTag(tag: SymbolTag): boolean {
  return hasMethodModifier(tag, METHOD_MODIFIERS.STATIC);
}

/**
 * Check if a tag is a constructor tag
 */
export function isConstructorTag(tag: SymbolTag): boolean {
  return hasMethodModifier(tag, METHOD_MODIFIERS.CONSTRUCTOR);
}

/**
 * Check if a tag is a destructor tag
 */
export function isDestructorTag(tag: SymbolTag): boolean {
  return hasMethodModifier(tag, METHOD_MODIFIERS.DESTRUCTOR);
}

/**
 * Check if a tag is a not-method tag
 */
export function isNotMethodTag(tag: SymbolTag): boolean {
  return tag.type === TAG_TYPES.NOT_METHOD;
}

/**
 * Find a tag by type in a list of tags
 */
export function findTagByType(tags: SymbolTag[] | undefined, type: string): SymbolTag | undefined {
  return tags?.find(tag => tag.type === type);
}

/**
 * Get the class name from a method tag (strips modifier if present)
 */
export function getMethodClassName(tag: SymbolTag): string | undefined {
  if (!isMethodTag(tag) || !tag.data) return undefined;
  const commaIdx = tag.data.indexOf(',');
  return commaIdx > 0 ? tag.data.substring(0, commaIdx) : tag.data;
}

/**
 * Get the modifier from a method tag (static, ctor, dtor)
 */
export function getMethodModifier(tag: SymbolTag): string | undefined {
  if (!isMethodTag(tag) || !tag.data) return undefined;
  const commaIdx = tag.data.indexOf(',');
  return commaIdx > 0 ? tag.data.substring(commaIdx + 1) : undefined;
}

/**
 * Check if a symbol is a method based on its tags
 */
export function isMethod(tags: SymbolTag[] | undefined): boolean {
  if (!tags) return false;
  return tags.some(tag => isMethodTag(tag));
}

/**
 * Get the method class name from tags
 */
export function getMethodClass(tags: SymbolTag[] | undefined): string | undefined {
  if (!tags) return undefined;
  for (const tag of tags) {
    const className = getMethodClassName(tag);
    if (className) return className;
  }
  return undefined;
}

/**
 * Create an add tag operation
 */
export function addTagOp(address: string, tag: SymbolTag) {
  return { address, tag, action: 'add' as const };
}

/**
 * Create a remove tag operation
 */
export function removeTagOp(address: string, tag: SymbolTag) {
  return { address, tag, action: 'remove' as const };
}

/**
 * Create multiple add tag operations for the same class
 */
export function addMethodTagsForClass(
  addresses: string[],
  className: string
): Array<{ address: string; tag: SymbolTag; action: 'add' | 'remove' }> {
  const tag = createMethodTag(className);
  return addresses.map(address => addTagOp(address, tag));
}

/**
 * Batch tag addresses with the same tag
 */
export function batchAddTag(
  addresses: string[],
  tag: SymbolTag
): Array<{ address: string; tag: SymbolTag; action: 'add' | 'remove' }> {
  return addresses.map(address => addTagOp(address, tag));
}

/**
 * Batch remove tags from addresses
 */
export function batchRemoveTag(
  addresses: string[],
  tag: SymbolTag
): Array<{ address: string; tag: SymbolTag; action: 'add' | 'remove' }> {
  return addresses.map(address => removeTagOp(address, tag));
}
