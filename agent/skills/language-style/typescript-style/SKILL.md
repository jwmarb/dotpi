---
name: typescript-style
description: "Modern TypeScript style guide + documentation polishing. Strict mode, discriminated unions, satisfies operator, branded types, explicit resource management, zero-runtime patterns. Also handles docstrings via JSDoc, inline comments, and documentation workflows. Triggers: 'typescript', 'ts files', 'style', 'idiomatic', 'pattern', 'refactor', 'design', 'type safety', 'strict', 'discriminated union', 'satisfies', 'branded', 'as const', 'result type', 'state machine', 'generic', 'utility type', 'type guard', 'NoInfer', 'explicit resource', 'using', 'docstring', 'documentation', 'comment', 'jsdoc'."
---

# TypeScript Style Guide - Modern Type-Safe Patterns + Polishing

**Philosophy**: TypeScript is not "JavaScript with annotations." It is a tool for making certain categories of bugs structurally impossible to write. Use the type system to eliminate impossible states, enforce invariants, and ship with confidence. Strict mode is non-negotiable.

Documentation is your code's contract with future maintainers (including yourself). Clear, concise JSDoc and inline comments reduce cognitive load without cluttering logic. When types are ambiguous, **prompt before guessing**.

**Reference Repositories**:
- `typescript/lib/` - Standard library type definitions
- `effect-ts/effect` - Functional error handling patterns
- `colinhacks/zod` - Runtime validation + type inference patterns
- `tanstack/query` - Async state machine patterns

---

## CORE PRINCIPLES

### 1. Strict Mode Always

```ts
// tsconfig.json — NEVER weaken these
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedDeclarations": true
  }
}
```

### 2. satisfies Over as-Casts

```ts
// BAD: Type assertion widens and loses literal types
const config: Record<string, string | number> = {
  port: 3000,
  host: 'localhost'
}
config.port  // string | number — lost!

// GOOD: satisfies validates AND preserves specific types
const config = {
  port: 3000,
  host: 'localhost'
} satisfies Record<string, string | number>
config.port  // number ✓
```

### 3. Discriminated Unions Over Optional Fields

```ts
// BAD: Optional fields allow impossible states
interface FetchState {
  loading: boolean
  data?: User
  error?: Error
}
// { loading: true, data: user, error: err } — logically impossible but allowed

// GOOD: Discriminated union makes impossible states unrepresentable
type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: User }
  | { status: 'error'; error: Error }

function handle(state: FetchState) {
  switch (state.status) {
    case 'success':
      console.log(state.data.toUpperCase()) // ✓ data is definitely User
    case 'error':
      console.error(state.error.message)    // ✓ error is definitely Error
  }
}
```

### 4. unknown Over any

```ts
// BAD: any disables type checking entirely
function process(data: any) {
  data.nonExistent.method() // Runtime crash waiting to happen
}

// GOOD: unknown requires type narrowing
function process(data: unknown) {
  if (isString(data)) {
    data.toUpperCase() // ✓ narrowed to string
  }
  if (isUser(data)) {
    console.log(data.name) // ✓ narrowed to User
  }
}
```

---

## PATTERN CATALOG

### Pattern 1: Branded Types (Nominal Typing)

TypeScript uses structural typing, which means `UserId` and `PostId` (both `string`) are interchangeable. Branding creates nominal types to prevent category errors.

```ts
// Brand utility
type Brand<T, B> = T & { readonly __brand: B }

// Domain types
type UserId = Brand<string, 'UserId'>
type PostId = Brand<string, 'PostId'>
type Amount = Brand<number, 'Amount'>
type EmailString = Brand<string, 'Email'>

// Factory functions
function createUserId(id: string): UserId {
  if (!id.startsWith('user_')) throw new Error('Invalid UserId format')
  return id as UserId
}

// Usage — compiler prevents mixing
function getUser(id: UserId): Promise<User> { ... }
function getPost(id: PostId): Promise<Post> { ... }

const uid = createUserId('user_123')
const pid = 'post_456' as PostId

getUser(uid)  // ✓
getUser(pid)  // ✗ Error: PostId is not assignable to UserId
```

**Why it matters**: Caught real bugs where `userId` was accidentally passed where `postId` was expected. No test required — the compiler prevents it.

### Pattern 2: Result Type (Explicit Error Handling)

Replace `try/catch` with an explicit Result type that forces callers to handle errors.

```ts
// Discriminated union — compiler forces exhaustive handling
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }

// Helper constructors
function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

function Err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error }
}

// Usage — errors become visible in the type
function parseJSON(input: string): Result<unknown> {
  try {
    return Ok(JSON.parse(input))
  } catch (e) {
    return Err(e instanceof Error ? e : new Error(String(e)))
  }
}

// Caller MUST handle both cases
const result = parseJSON('{"name": "Alice"}')
if (result.ok) {
  console.log(result.value) // ✓ value is parsed JSON
} else {
  console.error(result.error.message) // ✗ error is definitely present
}

// Functional chaining
function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? fn(result.value) : result
}
```

### Pattern 3: State Machines via Discriminated Unions

Model finite state machines where invalid transitions are unrepresentable.

```ts
// Connection state machine
type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; socket: WebSocket; connectedAt: Date }
  | { status: 'error'; error: Error; retryAt: Date }

class Connection {
  private state: ConnectionState = { status: 'disconnected' }

  connect() {
    switch (this.state.status) {
      case 'disconnected':
        this.state = { status: 'connecting', attempt: 1 }
        break
      case 'error':
        this.state = { status: 'connecting', attempt: this.state.attempt + 1 }
        break
      case 'connected':
        throw new Error('Already connected')
      case 'connecting':
        throw new Error('Already connecting')
    }
  }

  disconnect() {
    if (this.state.status === 'connected') {
      this.state.socket.close()
    }
    this.state = { status: 'disconnected' }
  }

  sendMessage(message: string) {
    if (this.state.status !== 'connected') {
      throw new Error('Must be connected to send')
    }
    this.state.socket.send(message)
  }
}
```

### Pattern 4: Template Literal Types for String Constraints

Enforce string patterns at compile time instead of runtime validation.

```ts
// Event naming convention
type EventName = `on${Capitalize<string>}`
// 'onClick', 'onSubmit' ✓
// 'click', 'handleClick' ✗

// API route patterns
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
type ApiRoute = `/api/${'v1' | 'v2'}/${string}`
type Route = `${HttpMethod} ${ApiRoute}`
// 'GET /api/v1/users' ✓
// 'GET /users' ✗

// CSS constraints
type CSSUnit = `${number}px` | `${number}rem` | `${number}%` | 'auto'
type CSSColor = `#${string}` | `rgb(${number}, ${number}, ${number})`

function sendTo(email: EmailDomain) {
  // Only trusted domains allowed at compile time
}
```

### Pattern 5: Const Assertions for Immutable Literals

`as const` infers the most specific literal types and makes properties readonly.

```ts
// Derive types from a single source of truth
const ROLES = ['admin', 'member', 'viewer'] as const
type Role = (typeof ROLES)[number] // 'admin' | 'member' | 'viewer'

const role: Role = 'superadmin' // ✗ Error! Not in the array

// Configuration objects with preserved literals
const THEME = {
  colors: {
    primary: '#4ade80',
    secondary: '#22d3ee',
    danger: '#f87171'
  },
  spacing: [0, 4, 8, 16, 24, 32] as const
} as const

// ROUTE_MAP keys become exact literal union
const ROUTES = {
  home: '/',
  users: '/users',
  settings: '/settings'
} as const

type RouteKey = keyof typeof ROUTES
// 'home' | 'users' | 'settings'
```

### Pattern 6: Type Guards and Type Predicates

Encapsulate type narrowing logic in reusable, testable functions.

```ts
// Basic type guards
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

// Discriminated union guard
function isSuccess(state: FetchState): state is Extract<FetchState, { status: 'success' }> {
  return state.status === 'success'
}

// Runtime validation with type narrowing
interface User {
  id: string
  name: string
  email: string
  age: number
}

function isUser(value: unknown): value is User {
  if (typeof value !== 'object' || value === null) return false
  
  const obj = value as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.email === 'string' &&
    typeof obj.age === 'number'
  )
}

// Usage
function process(data: unknown) {
  if (isUser(data)) {
    console.log(data.name) // ✓ data is User
  }
}
```

### Pattern 7: Assert Functions

Similar to type guards, but throw instead of returning false. Ideal for validating function preconditions.

```ts
// Assertion narrows type on success, throws on failure
function assertDefined<T>(value: T | undefined | null): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error('Expected value to be defined')
  }
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected string, got ${typeof value}`)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`)
}

// Usage
function processUser(user: User | undefined) {
  assertDefined(user)
  // user is now typed as User
  console.log(user.name.toUpperCase())
}

// Exhaustiveness with Never
function handleStatus(status: FetchState['status']) {
  switch (status) {
    case 'idle': return 'Wait'
    case 'loading': return 'Processing'
    case 'success': return 'Done'
    case 'error': return 'Failed'
    default:
      assertNever(status) // ✗ Compile error if new status added but not handled
  }
}
```

### Pattern 8: Builder Pattern with Compile-Time Guarantees

Use the type system to enforce required method call ordering.

```ts
type BuildState = {
  hasRequired: boolean
  hasOptional: boolean
}

class RequestBuilder<State extends BuildState = { hasRequired: false; hasOptional: false }> {
  private url = ''
  private headers: Record<string, string> = {}
  private timeout = 5000

  url(this: RequestBuilder<{ hasRequired: false }>, value: string) {
    this.url = value
    return this as RequestBuilder<{ hasRequired: true; hasOptional: State['hasOptional'] }>
  }

  header<K extends string, V extends string>(key: K, value: V) {
    this.headers[key] = value
    return this as RequestBuilder<State>
  }

  build(this: RequestBuilder<{ hasRequired: true }>) {
    return { url: this.url, headers: this.headers, timeout: this.timeout }
  }
}

// Usage
const request = new RequestBuilder()
  .url('/api/users')
  .header('Accept', 'application/json')
  .build() // ✓ compiles only after .url() called
```

### Pattern 9: NoInfer for Controlled Type Inference

TS 5.4+ — Prevent TypeScript from widening types based on the wrong parameter.

```ts
// Without NoInfer — T inferred from BOTH parameters (bad)
function createState<T>(initial: T, actions: Record<string, T>) {
  return { state: initial, actions }
}

// With NoInfer — T only inferred from initial
function createStateSafe<T>(initial: T, actions: Record<string, NoInfer<T>>) {
  return { state: initial, actions }
}

const safe = createStateSafe('hello', { greet: 'hello' }) // ✓
const safe2 = createStateSafe('hello', { greet: 'hello', increment: 42 }) // ✗ Error
```

### Pattern 10: Conditional and Mapped Types

Derive and transform types programmatically.

```ts
// Conditional types — type-level ternary
type Flatten<T> = T extends Array<infer U> ? U : T
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T

// Mapped types — transform properties
type Nullable<T> = { [K in keyof T]: T[K] | null }
type Readonly<T> = { readonly [K in keyof T]: T[K] }

// Generated property names
type User = { id: string; name: string; email: string }
type UserGetters = {
  [K in keyof User as `get${Capitalize<string & K>}`]: () => User[K]
}
// { getId: () => string; getName: () => string; getEmail: () => string }
```

### Pattern 11: Function Overloads for Developer Experience

Provide multiple signatures to guide consumers toward correct usage.

```ts
// Overload signatures (not visible to implementation)
function createElement(tag: 'img'): HTMLImageElement
function createElement(tag: 'input'): HTMLInputElement
function createElement(tag: 'a'): HTMLAnchorElement
function createElement(tag: string): HTMLElement

// Single implementation
function createElement(tag: string): HTMLElement {
  return document.createElement(tag)
}

// Usage gets precise types
const img = createElement('img')   // HTMLImageElement
const input = createElement('input') // HTMLInputElement
```

### Pattern 12: Generic Constraints

Limit what types can be passed to generics for better IntelliSense and safety.

```ts
// Constrain to keys of an object
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key]
}

// Constrain with multiple bounds
type WithId = { id: string }
type Mergeable<T extends WithId> = { [K in keyof T]-?: T[K] }

function mergeEntities<T extends WithId>(a: T, b: Partial<T>): T {
  return { ...a, ...b }
}
```

### Pattern 13: Type-Only Imports

Use `import type` or inline `type` for imports used only at compile time.

```ts
// Type-only import (removed at runtime)
import type { User, Role } from './types'
import { createServer, type ServerConfig } from './server'

// Why it matters:
// 1. Prevents circular dependencies
// 2. Reduces runtime bundle size
// 3. VerbatimModuleSyntax mode enforces this
```

### Pattern 14: Explicit Resource Management (TS 5.2+ / ES 2024)

The `using` declaration for automatic resource cleanup.

```ts
// Declare disposable resources
class DatabaseConnection implements Disposable {
  [Symbol.dispose]() {
    this.close()
  }
  
  close() {
    // cleanup
  }
}

// Automatic cleanup at scope exit
function fetchData() {
  using conn = new DatabaseConnection()
  const result = conn.query('SELECT * FROM users')
  // conn.dispose() called automatically when scope exits
  return result
}

async function processFile() {
  await using handle = new FileHandle()
  const data = await handle.read()
  return data
}
```

---

## DOCUMENTATION & POLISHER RULES

You polish code by adding clear, concise documentation via in-line comments and docstrings.

### When to Document

- When the user asks you to add documentation or comment code
- The user fully accepts code that you have written
- Code that has little to no documentation
- New public APIs, functions, or classes
- Complex business logic that needs explanation

### Docstring Rules (JSDoc Standard for TypeScript/JavaScript)

Docstrings should be clear, concise, and adhere to the JSDoc standard. The documentation must include:

1. **Purpose/Description**: A clear explanation of what the method or function does, including any assumptions or context necessary to understand its operation.
2. **Preconditions**: What must be true before the method is called.
3. **Postconditions**: What will be true after the method has executed.
4. **Parameters**: A list of all parameters, including their types, descriptions, and whether they are input, output, or both.
5. **Return Value**: What the method returns, if anything.
6. **Exceptions/Errors**: A description of any exceptions or errors the method may throw.

The documentation should be concise yet detailed enough to fully describe the method's functionality. **Avoid ambiguous types (e.g., `object`, `Object`, `unknown`, `any`), and if there is ambiguity with the types, please prompt the user or look up documentation for the type definition.**

#### Example: Properly Formatted JSDoc

```javascript
/**
 * Identifies the element with the largest magnitude from a numeric array.
 * 
 * Preconditions:
 * - array must not be empty
 * - numElements must match the actual length of array
 * 
 * @param {number[]} quakeList - The array of numeric magnitudes.
 * @param {number} numEntries - The number of elements in quakeList.
 * @returns {number} The index of the largest magnitude in the array.
 * @throws {Error} If array is empty or numEntries is incorrect.
 */
function findLargestQuake(quakeList: number[], numEntries: number): number {
  // ...
}
```

Another example with more complex types:

```typescript
/**
 * Processes incoming HTTP requests through the middleware chain and executes
 * the appropriate handler based on route matching.
 * 
 * Preconditions:
 * - request must contain valid URL path and method
 * - middlewareChain must not be empty
 * - routesMap must contain a matching entry for request.path
 * 
 * @param {IncomingMessage} req - The incoming HTTP request object.
 * @param {ServerResponse} res - The outgoing HTTP response object.
 * @param {Middleware[]} middlewareChain - Ordered middleware functions to execute.
 * @param {Record<string, Handler>} routesMap - Map of routes to handler functions.
 * @returns {Promise<void>} Resolves when processing completes (response sent or error thrown).
 * @throws {NotFound} If no matching route exists for the request path.
 * @throws {ValidationError} If request body fails schema validation.
 */
async function processRequest(
  req: IncomingMessage,
  res: ServerResponse,
  middlewareChain: Middleware[],
  routesMap: Record<string, Handler>
): Promise<void> {
  // ...
}
```

### Inline Comment Rules

Follow these best practices to make your comments clear, concise, and helpful without cluttering the code.

1. **Avoid Redundant Comments**: Do not repeat what the code already expresses. Provide additional context or rationale behind decisions.
2. **Refactor Instead of Commenting**: If you need extensive comments to clarify code, consider simplifying the code instead.
3. **Simplify Instead of Commenting**: Complex or unclear code often requires complex comments. Simplify the code if that's the case.
4. **Clarify, Don't Confuse**: Ensure your comments make the code clearer; if not, remove or rewrite them.
5. **Explain Unusual Code**: Provide context for any code that may look unusual to others.
6. **Cite External Sources**: For copied code, include links to the original source and author, including relevant discussions and updates.
7. **Link External References**: Reference external standards and specifications directly.
8. **Document Bug Fixes**: Include comments to detail fixes, referencing issues or bug reports when applicable.
9. **Mark Incomplete Implementations**: Use `TODO` comments to indicate unfinished tasks with additional details.

#### Example: Good Inline Comments

```typescript
// BAD: Comment repeating obvious code
// Convert each item to uppercase using map
const formattedData = data.map((item) => item.toUpperCase());

// GOOD: Comment explaining rationale
// Using map instead of loop for immutability—original would mutate input array.
const formattedData = data.map((item) => item.toUpperCase());

// BAD: Verbose comment
// This initializes an empty dictionary/object to store the final results here.
let resultObj: Record<string, number> = {};

// GOOD: Concise explanation
// Accumulator for frequency counting.
let resultObj: Record<string, number> = {};
```

#### Example: Well-Documented Snippet

```typescript
/**
 * Counts the occurrences of each uppercase word in the input array.
 * 
 * @param {string[]} data - Input array of lowercase words.
 * @returns {Record<string, number>} Object mapping words to counts.
 */
function countWords(data: string[]): Record<string, number> {
  // Transform to uppercase—immutably via map.
  const formatted = data.map((word) => word.toUpperCase());
  
  // Frequency accumulator keyed by word.
  const result: Record<string, number> = {};
  
  for (const word of formatted) {
    // Increment count or initialize at 1.
    result[word] = (result[word] ?? 0) + 1;
  }
  
  return result;
}

// Usage example
const words = ['apple', 'banana', 'cherry', 'apple'];
const counts = countWords(words);
console.log(counts);
// Output: { APPLE: 2, BANANA: 1, CHERRY: 1 }
```

This template ensures consistency, clarity, and adherence to the JSDoc documentation standard for TypeScript/JavaScript.

---

## WORKFLOW

**Before writing TypeScript code:**

1. **Is this modeling state with multiple possibilities?** → Use discriminated union
2. **Do I have similar primitive types?** → Use branded types
3. **Am I casting to satisfy the compiler?** → Use `satisfies` or validate with Zod
4. **Do I need literal types for config?** → Use `as const`
5. **Are there string patterns to enforce?** → Use template literal types
6. **Should this import be runtime-cost-free?** → Use `import type`
7. **Do I manage resources that need cleanup?** → Use `using` declaration

**When documenting code:**

1. **Understand behavioral logic first**: Recursively visit dependencies until you grasp the behavior. Prompt the user if uncertainties remain.
2. **Write JSDoc before the function signature**: This forces you to think about inputs, outputs, and side-effects upfront.
3. **Keep inline comments focused on why, not what**: Code shows what—it happens; comments explain why it's done that way.
4. **Verify types rigorously**: If any parameter or return type reads `object`, `Object`, `unknown`, or `any`, flag it for clarification before proceeding.

**Always enable strict mode. Always handle null explicitly. Never use `any` for uncertainty — use `unknown` with narrowing. Documentation is your contract with future developers; write it clearly.**

---

## UTILITY TYPES REFERENCE

| Utility | Purpose | Example |
|---------|---------|---------|
| `Partial<T>` | All properties optional | `Partial<User>` |
| `Required<T>` | All properties required | `Required<PartialUser>` |
| `Readonly<T>` | All properties readonly | `Readonly<Config>` |
| `Pick<T, K>` | Select subset | `Pick<User, 'id' \| 'name'>` |
| `Omit<T, K>` | Exclude subset | `Omit<User, 'password'>` |
| `Record<K, V>` | Key-value map | `Record<string, number>` |
| `NonNullable<T>` | Exclude null/undefined | `NonNullable<string \| null>` |
| `Awaited<T>` | Unwrap Promise | `Awaited<Promise<User>>` |
| `ReturnType<T>` | Function return type | `ReturnType<typeof fn>` |
| `Parameters<T>` | Function params | `Parameters<typeof fn>` |
| `InstanceType<T>` | Class instance type | `InstanceType<typeof MyClass>` |
| `Exclude<T, U>` | Remove from union | `Exclude<'a' \| 'b', 'a'>` |
| `Extract<T, U>` | Keep intersection | `Extract<'a' \| 'b', 'a'>` |
| `NoInfer<T>` | Prevent inference | `fn<T>(init: T, actions: NoInfer<T>)` |
| `Satisfies` | Validate without widening | `obj satisfies Type` |

---

## WHEN TO USE WHAT

| You Need | Use This | Not This |
|----------|----------|----------|
| State with mutually exclusive fields | Discriminated union | Optional fields |
| Type-specific string patterns | Template literal types | `string` |
| Prevent mixing similar primitives | Branded types | Bare `string` or `number` |
| Validate config at compile time | `satisfies` | `as Type` |
| Immutable literal types | `as const` | Manual type annotation |
| Force exhaustive switch | `never` + assert | Manual comments |
| Runtime validation + types | Zod + inference | `as` casts |
| Prevent type widening | `NoInfer<T>` | Generic inference |
| Auto resource cleanup | `using` declaration | `try/finally` |
| Extend external types | Module augmentation | Global namespace pollution |
| Type-only at compile time | `import type` | Regular import |
| Compose unrelated types | Intersection `&` | Classical inheritance |

---

## LOOKUP COMMANDS

### Find Type Definitions in TypeScript Compiler

```bash
# Find utility type definitions
rg "^type Partial<" node_modules/typescript/lib/lib.es5.d.ts -A 5

# Find lib definitions
rg "^type Awaited<" node_modules/typescript/lib/lib.es2021.promise.d.ts -A 3

# Find built-in utility types
rg "^type (Partial|Required|Readonly|Pick|Omit|Record)" node_modules/typescript/lib/ -A 3
```

### Find Patterns in Real-World Projects

```bash
# How does Effect.ts handle Result types?
rg "type Result<" node_modules/@effect/ --type ts | head -20

# How does Zod combine runtime + types?
rg "type.*infer" node_modules/zod/lib/ --type ts | head -20

# How does TanStack Query model async state?
rg "type.*QueryStatus" node_modules/@tanstack/ --type ts | head -20

# How does Express handle Request augmentation?
rg "declare namespace Express" node_modules/@types/express/ --type ts | head -10
```

### Inspect Your Own Types

```ts
# See inferred types (VS Code hover)
# Hover over variables, function returns, generic usages

# Type-level debugging
type Debug<T> = { [K in keyof T]: T[K] }
type Result = Debug<typeof someObject>

// Force type display via assignment
const _check: never = valueThatShouldBeNever
// If it compiles, value IS never (exhaustive check passed)
```

---

## FINAL CHECKLIST

**Before committing TypeScript code, verify:**

```
✓ strict: true enabled in tsconfig
✓ No usage of any — replaced with unknown or specific types
✓ Discriminated unions used for multi-state logic
✓ Satisfies used for config/validation instead of as-casts
✅ Branded types applied where ID/primitive confusion risk exists
✅ As const used for immutable configuration values
✅ Import type used for type-only imports
✅ JSDoc written for all public APIs
✅ Inline comments explain why, not what
✅ No redundant or misleading comments
✅ Ambiguous types resolved or clarified with user
✅ Null checks handled explicitly throughout
```

**Remember: The TypeScript compiler is not an annoyance — it's your most valuable collaborator. When it complains, listen. Documentation is your contract with future developers — honor it.**