/** Restore a direct pointer-field store before retaining its address for later calls. */
import {NodeKind} from '../../../ast/kinds.js';
import type {ASTNode,AssignExpr,CallExpr,CompoundStmt,DeclStmt,ExprStmt,Expression,FunctionDecl,Identifier,IfStmt,MemberExpr,ParameterDecl,ReturnStmt,UnaryExpr,VariableDecl} from '../../../ast/nodes.js';
import {emit} from '../../../emit/index.js';
import {findNodesByKind} from '../../../ast/visitor.js';
import {cloneNode} from '../../transformer.js';
import {unwrapParens} from './call-arg-cast.js';
import {calleeSpelling} from '../../cfg/index.js';

interface Field {name:string;offset:number;size:number;type:string;bitSize?:number}
export interface FieldAliasStoreTables {
 targetPointerSize?:number;
 structLayouts?:Record<string,readonly Field[]>;
 aggregateSizes?:Record<string,number>;
 unionNames?:readonly string[];
 functionReturnTypes?:Record<string,string>;
}
interface Binding {type:string;local?:VariableDecl;parameter?:ParameterDecl}
const text=(n:ASTNode):string=>emit(n as never).replace(/\s+/g,'');
const id=(e:Expression):string|undefined=>{const n=unwrapParens(e);return n.kind===NodeKind.Identifier?(n as Identifier).name:undefined;};
function arrow(e:Expression):{object:string;field:string}|undefined {
 const n=unwrapParens(e);if(n.kind!==NodeKind.MemberExpr)return;
 const m=n as MemberExpr,object=id(m.object);
 return m.isArrow&&object&&m.member.kind===NodeKind.Identifier?{object,field:(m.member as Identifier).name}:undefined;
}
function scalarSize(type:string):number|undefined {
 const t=type.trim().replace(/\s+/g,' ');
 if(/^(?:bool|byte|BYTE|char|signed char|unsigned char|int8_t|uint8_t)$/.test(t))return 1;
 if(/^(?:short|short int|unsigned short|unsigned short int|int16_t|uint16_t|WORD|USHORT)$/.test(t))return 2;
 if(/^(?:int|unsigned int|long|unsigned long|int32_t|uint32_t|BOOL|DWORD)$/.test(t))return 4;
}

/**
 * `T** a=&q->field; T* v=Make(); *a=v; if(!q->flag)return; ...Use(a)`
 * becomes `q->field=Make(); T** a=&q->field; if(!q->flag)return; ...Use(a)`.
 * Only the pure address calculation moves. Pointer/field types agree exactly,
 * receiver and alias bindings are unique and stable, the tested field is disjoint,
 * and a folded producer has exactly one value use. No store is duplicated.
 */
export function restoreFieldAliasStore(fn:FunctionDecl,name:string,tables?:FieldAliasStoreTables):boolean {
 const ptr=tables?.targetPointerSize;
 if(!fn.body||text(fn.returnType)!=='void'||(ptr!==4&&ptr!==8))return false;
 if([NodeKind.GotoStmt,NodeKind.LabelStmt,NodeKind.SwitchStmt,NodeKind.WhileStmt,NodeKind.DoWhileStmt,NodeKind.ForStmt,NodeKind.LambdaExpr,NodeKind.FunctionDecl,NodeKind.MethodDecl,NodeKind.ClassDecl,NodeKind.StructDecl,NodeKind.UnionDecl]
  .some(k=>findNodesByKind(fn.body!,k).length))return false;
 const locals=findNodesByKind(fn.body,NodeKind.VariableDecl) as VariableDecl[];
 const bindings=new Map<string,Binding[]>();
 for(const [decl,parameter]of [...fn.parameters.map(p=>[p,true] as const),...locals.map(v=>[v,false] as const)]){
  if(!decl.name)continue;const list=bindings.get(decl.name.name)??[];
  list.push({type:emit(decl.type),...(parameter?{parameter:decl as ParameterDecl}:{local:decl as VariableDecl})});bindings.set(decl.name.name,list);
 }
 const one=(n:string):Binding|undefined=>bindings.get(n)?.length===1?bindings.get(n)![0]:undefined;
 const stable=(n:string):boolean=>{
  if(!one(n))return false;
  for(const a of findNodesByKind(fn.body!,NodeKind.AssignExpr) as AssignExpr[])if(id(a.left)===n)return false;
  for(const u of [...findNodesByKind(fn.body!,NodeKind.UnaryExpr),...findNodesByKind(fn.body!,NodeKind.PostfixExpr)] as UnaryExpr[])
   if(['&','++','--'].includes(u.operator)&&id(u.operand)===n)return false;
  return true;
 };
 const declaration=(binding:Binding,block:CompoundStmt):number=>block.statements.findIndex(s=>s.kind===NodeKind.DeclStmt&&
  (s as DeclStmt).declarations.length===1&&(s as DeclStmt).declarations[0]===binding.local);
 const before=(binding:Binding,block:CompoundStmt,index:number):boolean=>!!binding.parameter||
  (!!binding.local?.initializer&&declaration(binding,block)>=0&&declaration(binding,block)<index);
 const field=(type:string,n:string):Field|undefined=>{
  if(tables?.unionNames?.includes(type))return;
  const layout=tables?.structLayouts?.[type]??[],found=layout.filter(f=>f.name===n),size=tables?.aggregateSizes?.[type];
  if(found.length!==1||!Number.isSafeInteger(size))return;
  const f=found[0];
  if(f.bitSize!==undefined||!Number.isSafeInteger(f.offset)||!Number.isSafeInteger(f.size)||f.offset<0||f.size<=0||f.offset+f.size>size!)return;
  if(layout.some(g=>g!==f&&g.offset<f.offset+f.size&&f.offset<g.offset+g.size))return;
  return f;
 };
 const alias=one(name);if(!alias?.local?.initializer||alias.local.specifiers.length||!stable(name))return false;
 const stores=(findNodesByKind(fn.body,NodeKind.AssignExpr) as AssignExpr[]).filter(a=>{
  const left=unwrapParens(a.left);return left.kind===NodeKind.UnaryExpr&&(left as UnaryExpr).operator==='*'&&id((left as UnaryExpr).operand)===name;
 });
 if(stores.length!==1)return false;
 const init=unwrapParens(alias.local.initializer as Expression);
 if(init.kind!==NodeKind.UnaryExpr||(init as UnaryExpr).operator!=='&')return false;
 const place=(init as UnaryExpr).operand,destination=arrow(place);
 if(!destination||!stable(destination.object))return false;
 const object=one(destination.object),pointee=object?.type.trim().match(/^(?:::)?([A-Za-z_]\w*)\s*\*$/)?.[1];
 if(!object||!pointee)return false;
 const hits:Array<{block:CompoundStmt;start:number;index:number;store:ExprStmt;inline?:VariableDecl;aliasStmt:DeclStmt}>=[];
 const blocks=new Set([fn.body,...findNodesByKind(fn.body,NodeKind.CompoundStmt) as CompoundStmt[]]);
 for(const block of blocks)for(let i=0;i+1<block.statements.length;i++){
  const s=block.statements[i],next=block.statements[i+1],ai=declaration(alias,block);
  if(s.kind!==NodeKind.ExprStmt||next.kind!==NodeKind.IfStmt||ai<0||ai>=i||i-ai>2||!before(object,block,ai))continue;
  const e=unwrapParens((s as ExprStmt).expression);if(e.kind!==NodeKind.AssignExpr)continue;
  const store=e as AssignExpr,lhs=unwrapParens(store.left),guard=next as IfStmt;
  if(store.operator!=='='||lhs.kind!==NodeKind.UnaryExpr||(lhs as UnaryExpr).operator!=='*'||id((lhs as UnaryExpr).operand)!==name||guard.init||guard.elseBranch)continue;
  const arm=guard.thenBranch.kind===NodeKind.CompoundStmt?(guard.thenBranch as CompoundStmt).statements:[guard.thenBranch];
  if(arm.length!==1||arm[0].kind!==NodeKind.ReturnStmt||(arm[0] as ReturnStmt).value)continue;
  const condition=unwrapParens(guard.condition);if(condition.kind!==NodeKind.UnaryExpr||(condition as UnaryExpr).operator!=='!')continue;
  const test=arrow((condition as UnaryExpr).operand);if(!test||test.object!==destination.object)continue;
  const a=field(pointee,destination.field),b=field(pointee,test.field);
  if(!a||!b||a.size!==ptr||!/^(?:::)?[A-Za-z_]\w*\s*\*$/.test(a.type.trim())||scalarSize(b.type)!==b.size)continue;
  if(a.offset<b.offset+b.size&&b.offset<a.offset+a.size||alias.type.replace(/\s+/g,'')!==a.type.replace(/\s+/g,'')+'*')continue;
  const rhsName=id(store.right),rhs=rhsName&&one(rhsName);
  if(!rhsName||!rhs||!stable(rhsName)||!before(rhs,block,i)||rhs.type.replace(/\s+/g,'')!==a.type.replace(/\s+/g,''))continue;
  if(rhs.local?.specifiers.length)continue;
  const ri=rhs.local?declaration(rhs,block):-1;
  // No statement besides the producer may lie between the alias and its store.
  if(i-ai===2&&ri!==ai+1)continue;
  if(ri===ai+1&&findNodesByKind(rhs.local!.initializer as ASTNode,NodeKind.Identifier).some(n=>(n as Identifier).name===name))continue;
  const uses=rhs.local?(findNodesByKind(fn.body,NodeKind.Identifier) as Identifier[]).filter(n=>n.name===rhsName&&n!==rhs.local!.name):[];
  const producer=rhs.local?.initializer&&unwrapParens(rhs.local.initializer as Expression);
  const callee=producer?.kind===NodeKind.CallExpr?calleeSpelling(producer as CallExpr):null;
  // A class-valued call can convert to T* and destroy its temporary at the
  // declaration. Folding it into the assignment would move that destructor
  // after the store. Inline only an unshadowed, exact pointer-returning call.
  const returned=callee&&!bindings.has(callee)?tables?.functionReturnTypes?.[callee]:undefined;
  const inline=returned?.replace(/\s+/g,'')===a.type.replace(/\s+/g,'')&&
   uses.length===1&&(ri===ai-1||ri===ai+1)?rhs.local:undefined;
  hits.push({block,start:inline?Math.min(ai,ri):ai,index:i,store:s as ExprStmt,inline,aliasStmt:block.statements[ai] as DeclStmt});
 }
 if(hits.length!==1)return false;
 const {block,start,index,store,inline,aliasStmt}=hits[0],direct=cloneNode(store);
 const assignment=unwrapParens(direct.expression) as AssignExpr;assignment.left=cloneNode(place);
 if(inline)assignment.right=cloneNode(inline.initializer as Expression);
 const kept=block.statements.slice(start,index).filter(s=>s!==aliasStmt&&!(s.kind===NodeKind.DeclStmt&&(s as DeclStmt).declarations.includes(inline!)));
 block.statements.splice(start,index-start+1,...kept,direct,cloneNode(aliasStmt));
 return true;
}
