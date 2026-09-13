---
name: rust-style
description: "Idiomatic Rust style guide. Prefer traits over functions, enums over strings, impl blocks over derive clones. Zero-cost abstractions. Triggers: 'rust', 'cargo', '.rs files', 'style', 'idiomatic', 'pattern', 'refactor', 'design', 'architecture', 'trait', 'enum', 'impl', 'newtype', 'builder', 'typestate', 'macro', 'const generic', 'GAT'."
---
# Rust Style Guide - Idiomatic Patterns
**Philosophy**: Write Rust like a Rustacean. Prefer traits, enums, and impl blocks over functions and derive clones. Use the type system to encode invariants. Make illegal states unrepresentable.
---
## CORE PRINCIPLES
### 1. Traits Over Functions
```rust
// BAD: Gazillion functions
fn process_json(data: &str) -> Result<Value, Error> { ... }
fn process_xml(data: &str) -> Result<Value, Error> { ... }
fn process_yaml(data: &str) -> Result<Value, Error> { ... }
// GOOD: Trait-based design
trait Deserialize: Sized {
    type Error;
    fn deserialize(input: &str) -> Result<Self, Self::Error>;
}
impl Deserialize for Json { ... }
impl Deserialize for Xml { ... }
impl Deserialize for Yaml { ... }
// Generic over any deserializable type
fn process<T: Deserialize>(input: &str) -> Result<T, T::Error> {
    T::deserialize(input)
}
```
### 2. Enums Over Stringly-Typed Code
```rust
// BAD: Stringly-typed
fn set_status(status: &str) { ... }
set_status("pending");  // Typo? "Pending"? "PENDING"?
// GOOD: Type-safe enum
enum Status {
    Pending,
    Active,
    Completed,
    Failed { reason: String },
}
fn set_status(status: Status) { ... }
set_status(Status::Pending);  // Compiler-checked
```
### 3. Impl Blocks Over Derive Clone Spam
```rust
// BAD: Clone everything, pass by value
#[derive(Clone)]
struct Config {
    large_data: Vec<u8>,
    settings: HashMap<String, String>,
}
fn process(config: Config) { ... }  // Takes ownership, forces clone
// GOOD: References and borrowing
struct Config {
    large_data: Vec<u8>,
    settings: HashMap<String, String>,
}
impl Config {
    fn process(&self) -> Result<Output, Error> { ... }
    fn settings(&self) -> &HashMap<String, String> { &self.settings }
}
```
### 4. Newtypes for Type Safety
```rust
// BAD: Primitive obsession
fn transfer(from: u64, to: u64, amount: u64) { ... }
transfer(amount, to, from);  // Easy to mix up!
// GOOD: Newtypes
struct AccountId(u64);
struct Amount(u64);
fn transfer(from: AccountId, to: AccountId, amount: Amount) { ... }
// transfer(amount, to, from);  // Won't compile!
```
---
## PATTERN CATALOG
### Pattern 1: Typestate
Encode state machine transitions in the type system.
```rust
// State markers (zero-sized types)
struct Uninitialized;
struct Configured;
struct Running;
struct Server<State> {
    config: Option<Config>,
    _state: PhantomData<State>,
}
impl Server<Uninitialized> {
    fn new() -> Self {
        Server { config: None, _state: PhantomData }
    }
    fn configure(self, config: Config) -> Server<Configured> {
        Server { config: Some(config), _state: PhantomData }
    }
}
impl Server<Configured> {
    fn start(self) -> Result<Server<Running>, Error> {
        // Can only start after configuration
        Ok(Server { config: self.config, _state: PhantomData })
    }
}
impl Server<Running> {
    fn handle_request(&self, req: Request) -> Response { ... }
}
// Usage: Compiler enforces correct ordering
let server = Server::new()
    .configure(config)
    .start()?;
// server.configure(...)  // Won't compile - wrong state
```
**Reference**: Look up `library/core/src/iter/adapters/` for iterator typestate patterns.
### Pattern 2: Builder with Type Guarantees
```rust
// Builder that enforces required fields at compile time
struct RequestBuilder<Host, Path> {
    host: Host,
    path: Path,
    headers: Vec<(String, String)>,
}
struct NoHost;
struct HasHost(String);
struct NoPath;
struct HasPath(String);
impl RequestBuilder<NoHost, NoPath> {
    fn new() -> Self {
        RequestBuilder {
            host: NoHost,
            path: NoPath,
            headers: vec![],
        }
    }
}
impl<P> RequestBuilder<NoHost, P> {
    fn host(self, host: impl Into<String>) -> RequestBuilder<HasHost, P> {
        RequestBuilder {
            host: HasHost(host.into()),
            path: self.path,
            headers: self.headers,
        }
    }
}
impl<H> RequestBuilder<H, NoPath> {
    fn path(self, path: impl Into<String>) -> RequestBuilder<H, HasPath> {
        RequestBuilder {
            host: self.host,
            path: HasPath(path.into()),
            headers: self.headers,
        }
    }
}
// build() only available when both Host and Path are set
impl RequestBuilder<HasHost, HasPath> {
    fn build(self) -> Request {
        Request {
            host: self.host.0,
            path: self.path.0,
            headers: self.headers,
        }
    }
}
// Optional methods available in any state
impl<H, P> RequestBuilder<H, P> {
    fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }
}
// Usage
let req = RequestBuilder::new()
    .host("example.com")
    .path("/api")
    .header("Content-Type", "application/json")
    .build();  // Only compiles if host AND path are set
```
### Pattern 3: Extension Traits
Add methods to external types without modifying them.
```rust
// Extension trait pattern
trait StringExt {
    fn truncate_with_ellipsis(&self, max_len: usize) -> String;
    fn is_blank(&self) -> bool;
}
impl StringExt for str {
    fn truncate_with_ellipsis(&self, max_len: usize) -> String {
        if self.len() <= max_len {
            self.to_string()
        } else {
            format!("{}...", &self[..max_len.saturating_sub(3)])
        }
    }
    fn is_blank(&self) -> bool {
        self.chars().all(char::is_whitespace)
    }
}
// Usage
"hello world".truncate_with_ellipsis(8);  // "hello..."
"   ".is_blank();  // true
```
**Reference**: Look up `library/core/src/iter/traits/iterator.rs` for the canonical extension trait.
### Pattern 4: Error Enums with Context
```rust
use thiserror::Error;
#[derive(Debug, Error)]
enum ApiError {
    #[error("authentication failed for user {user}")]
    AuthFailed { user: String },
    #[error("resource {resource_type}/{id} not found")]
    NotFound { resource_type: &'static str, id: String },
    #[error("rate limit exceeded, retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("request timed out after {elapsed:?}")]
    Timeout { elapsed: Duration },
    #[error("internal error")]
    Internal {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}
// Convert other errors with context
impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        ApiError::Internal { source: Box::new(err) }
    }
}
```
### Pattern 5: Smart Constructors
Validate at construction, not at use.
```rust
/// A validated email address.
///
/// Invariant: Always contains exactly one '@' with non-empty local and domain.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Email(String);
impl Email {
    /// Creates a new Email if the input is valid.
    pub fn new(s: impl Into<String>) -> Result<Self, EmailError> {
        let s = s.into();
        // Validate once at construction
        let at_pos = s.find('@')
            .ok_or(EmailError::MissingAt)?;
        if at_pos == 0 {
            return Err(EmailError::EmptyLocal);
        }
        if at_pos == s.len() - 1 {
            return Err(EmailError::EmptyDomain);
        }
        Ok(Email(s))
    }
    /// Returns the email as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// Returns the local part (before @).
    pub fn local(&self) -> &str {
        // SAFETY: Constructor guarantees @ exists and isn't first
        &self.0[..self.0.find('@').unwrap()]
    }
    /// Returns the domain part (after @).
    pub fn domain(&self) -> &str {
        // SAFETY: Constructor guarantees @ exists and isn't last
        &self.0[self.0.find('@').unwrap() + 1..]
    }
}
#[derive(Debug, Error)]
pub enum EmailError {
    #[error("email must contain '@'")]
    MissingAt,
    #[error("local part cannot be empty")]
    EmptyLocal,
    #[error("domain cannot be empty")]
    EmptyDomain,
}
```
### Pattern 6: Sealed Traits
Prevent external implementations of a trait.
```rust
mod private {
    pub trait Sealed {}
}
/// A transport layer for the client.
///
/// This trait is sealed and cannot be implemented outside this crate.
pub trait Transport: private::Sealed {
    fn send(&self, data: &[u8]) -> Result<(), Error>;
    fn recv(&self) -> Result<Vec<u8>, Error>;
}
// Internal types can implement
pub struct TcpTransport { ... }
impl private::Sealed for TcpTransport {}
impl Transport for TcpTransport { ... }
pub struct UdpTransport { ... }
impl private::Sealed for UdpTransport {}
impl Transport for UdpTransport { ... }
// External types cannot implement Transport because they can't impl Sealed
```
### Pattern 7: Zero-Cost Wrappers
Wrap types with zero runtime overhead.
```rust
/// A wrapper that guarantees the inner value is non-empty.
#[repr(transparent)]
pub struct NonEmpty<T>(T);
impl NonEmpty<Vec<u8>> {
    pub fn new(vec: Vec<u8>) -> Option<Self> {
        if vec.is_empty() {
            None
        } else {
            Some(NonEmpty(vec))
        }
    }
    /// Returns the first element.
    ///
    /// # Safety
    /// The constructor guarantees non-empty, so this never panics.
    pub fn first(&self) -> &u8 {
        // SAFETY: Invariant maintained by constructor
        unsafe { self.0.get_unchecked(0) }
    }
    pub fn into_inner(self) -> Vec<u8> {
        self.0
    }
}
impl<T> std::ops::Deref for NonEmpty<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
```
### Pattern 8: Declarative Macros for Repetition
```rust
/// Define enum with string conversion
macro_rules! define_enum {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $($variant:ident => $str:literal),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis enum $name {
            $($variant),*
        }
        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $str),*
                }
            }
        }
        impl std::str::FromStr for $name {
            type Err = ParseError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($str => Ok(Self::$variant),)*
                     _=> Err(ParseError::UnknownVariant(s.to_string())),
                }
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}
// Usage
define_enum! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum HttpMethod {
        Get => "GET",
        Post => "POST",
        Put => "PUT",
        Delete => "DELETE",
        Patch => "PATCH",
    }
}
```
**Reference**: Look up `library/core/src/macros/mod.rs` for stdlib macro patterns.
### Pattern 9: Trait Objects vs Generics
```rust
// Generics: Zero-cost, monomorphized, larger binary
fn process_generic<T: Handler>(handler: T) {
    handler.handle();
}
// Trait objects: Dynamic dispatch, smaller binary, slight runtime cost
fn process_dyn(handler: &dyn Handler) {
    handler.handle();
}
// When to use which:
// - Generics: Hot paths, performance critical, small number of types
// - Trait objects: Plugin systems, configuration, heterogeneous collections
// Heterogeneous collection example
struct Pipeline {
    handlers: Vec<Box<dyn Handler>>,
}
impl Pipeline {
    fn add<H: Handler + 'static>(&mut self, handler: H) {
        self.handlers.push(Box::new(handler));
    }
    fn run(&self) {
        for handler in &self.handlers {
            handler.handle();
        }
    }
}
```
### Pattern 10: Interior Mutability When Needed
```rust
use std::cell::RefCell;
use std::sync::{Arc, RwLock};
// Single-threaded: RefCell
struct Cache {
    data: RefCell<HashMap<String, Value>>,
}
impl Cache {
    fn get(&self, key: &str) -> Option<Value> {
        self.data.borrow().get(key).cloned()
    }
    fn insert(&self, key: String, value: Value) {
        self.data.borrow_mut().insert(key, value);
    }
}
// Multi-threaded: RwLock (or parking_lot)
struct SharedCache {
    data: Arc<RwLock<HashMap<String, Value>>>,
}
impl SharedCache {
    fn get(&self, key: &str) -> Option<Value> {
        self.data.read().ok()?.get(key).cloned()
    }
    fn insert(&self, key: String, value: Value) {
        if let Ok(mut guard) = self.data.write() {
            guard.insert(key, value);
        }
    }
}
```
---
## ANTI-PATTERNS TO AVOID
### 1. Clone-Happy Code
```rust
// BAD: Cloning everywhere
fn process(data: String) {
    let copy1 = data.clone();
    let copy2 = data.clone();
    do_thing(copy1);
    do_other_thing(copy2);
}
// GOOD: Use references
fn process(data: &str) {
    do_thing(data);
    do_other_thing(data);
}
```
### 2. Stringly-Typed APIs
```rust
// BAD
fn configure(key: &str, value: &str) { ... }
configure("timout", "30");  // Typo in "timeout", compiles fine
// GOOD
enum ConfigKey {
    Timeout,
    MaxRetries,
    BaseUrl,
}
fn configure(key: ConfigKey, value: impl Into<ConfigValue>) { ... }
```
### 3. Primitive Obsession
```rust
// BAD: All u64, easy to confuse
fn create_order(user_id: u64, product_id: u64, quantity: u64, price: u64) { ... }
// GOOD: Distinct types
struct UserId(u64);
struct ProductId(u64);
struct Quantity(u32);
struct Price(Decimal);
fn create_order(user: UserId, product: ProductId, qty: Quantity, price: Price) { ... }
```
### 4. Boolean Blindness
```rust
// BAD: What do these booleans mean?
fn open_file(path: &str, read: bool, write: bool, create: bool) { ... }
// GOOD: Use enums or builder
enum OpenMode {
    Read,
    Write,
    ReadWrite,
    Append,
}
struct OpenOptions {
    mode: OpenMode,
    create: bool,
    truncate: bool,
}
```
### 5. Excessive Derive
```rust
// BAD: Derive everything "just in case"
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
struct Handle(u64);
// GOOD: Only what you need
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Handle(u64);
```
---
## LOOKUP COMMANDS
### Find Trait Patterns in Stdlib
```bash
# How does Iterator work?
rg "^pub trait Iterator" ~/RustProjects/forks/rust/library/core/src/iter/ -A 30
# How does From/Into work?
Read ~/RustProjects/forks/rust/library/core/src/convert/mod.rs
# How does Display work?
Read ~/RustProjects/forks/rust/library/core/src/fmt/mod.rs
# How does Default work?
Read ~/RustProjects/forks/rust/library/core/src/default.rs
```
### Find Real-World Patterns in Tokio
```bash
# How does tokio structure sync primitives?
ls ~/RustProjects/forks/tokio/tokio/src/sync/
# How does Mutex implement interior mutability?
Read ~/RustProjects/forks/tokio/tokio/src/sync/mutex.rs
# How does mpsc channel work?
Read ~/RustProjects/forks/tokio/tokio/src/sync/mpsc/mod.rs
```
### Find Web Framework Patterns in Poem
```bash
# How does poem structure routes?
ls ~/RustProjects/forks/poem/poem/src/
# How does poem handle extractors?
rg "impl.*FromRequest" ~/RustProjects/forks/poem/poem/src/ -l
# How does poem-openapi work?
ls ~/RustProjects/forks/poem/poem-openapi/src/
```
### Find Frontend Patterns in Leptos
```bash
# How does leptos handle reactivity?
ls ~/RustProjects/forks/leptos/leptos/src/
# How does leptos handle components?
rg "fn component" ~/RustProjects/forks/leptos/ --type rust | head -20
```
---
## WHEN TO APPLY THESE PATTERNS
| Situation | Pattern to Use |
|-----------|----------------|
| Multiple similar functions | Extract trait |
| String constants for states | Use enum |
| Many constructor parameters | Builder pattern |
| Enforcing state transitions | Typestate |
| Wrapping primitives for safety | Newtype |
| Adding methods to foreign types | Extension trait |
| Preventing invalid construction | Smart constructor |
| Preventing external implementation | Sealed trait |
| Repetitive boilerplate | Declarative macro |
| Heterogeneous collections | Trait objects |
| Performance-critical generics | Monomorphization |
---
## WORKFLOW
1. **Before writing functions**: Ask "Could this be a trait?"
2. **Before using strings**: Ask "Could this be an enum?"
3. **Before derive(Clone)**: Ask "Do I really need ownership?"
4. **Before bare primitives**: Ask "Should this be a newtype?"
5. **Before repetitive code**: Ask "Should this be a macro?"
**Always look up stdlib and tokio patterns before inventing your own.**
---
## ADVANCED PATTERNS FROM STDLIB
### Pattern 11: Const Generics for Compile-Time Sizes
The stdlib uses const generics extensively for array operations without runtime overhead.
```rust
// Array operations with compile-time sizes
impl<T, const N: usize> [T; N] {
    pub fn split_array_ref<const M: usize>(&self) -> (&[T; M], &[T]) {
        assert!(M <= N, "split point out of bounds");
        // SAFETY: M <= N checked above
        unsafe {
            let (left, right) = self.split_at(M);
            let left_ptr = left.as_ptr() as *const [T; M];
            (&*left_ptr, right)
        }
    }
}
// Const generic functions
fn process_chunk<const BLOCK_SIZE: usize>(data: [u8; BLOCK_SIZE]) -> [u8; BLOCK_SIZE] {
    // Compiler knows exact size, can optimize heavily
    let mut result = [0u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        result[i] = data[i].wrapping_add(1);
    }
    result
}
// Use case: Ring buffer with compile-time capacity
struct RingBuffer<T, const CAP: usize> {
    data: [Option<T>; CAP],
    read: usize,
    write: usize,
}
impl<T, const CAP: usize> RingBuffer<T, CAP> {
    const fn new() -> Self {
        Self {
            data: [const { None }; CAP],
            read: 0,
            write: 0,
        }
    }
    fn push(&mut self, item: T) -> Result<(), T> {
        let next = (self.write + 1) % CAP;
        if next == self.read {
            Err(item)  // Full
        } else {
            self.data[self.write] = Some(item);
            self.write = next;
            Ok(())
        }
    }
}
```
**Reference**: Look up `library/core/src/array/mod.rs` for array const generic patterns.
### Pattern 12: Associated Types for Protocol Design
```rust
// Protocol trait with associated types
trait Protocol {
    type Request;
    type Response;
    type Error;
    fn handle(&mut self, req: Self::Request) -> Result<Self::Response, Self::Error>;
}
// HTTP implementation
struct HttpProtocol;
impl Protocol for HttpProtocol {
    type Request = HttpRequest;
    type Response = HttpResponse;
    type Error = HttpError;
    fn handle(&mut self, req: HttpRequest) -> Result<HttpResponse, HttpError> {
        // ...
    }
}
// Generic handler works with any protocol
fn serve<P: Protocol>(mut protocol: P, requests: impl Iterator<Item = P::Request>) {
    for req in requests {
        match protocol.handle(req) {
            Ok(resp) => send_response(resp),
            Err(err) => log_error(err),
        }
    }
}
```
### Pattern 13: Marker Types for Type-Level Programming
```rust
// Zero-sized marker types
struct Initialized;
struct Uninitialized;
struct Buffer<State> {
    data: Vec<u8>,
    _state: PhantomData<State>,
}
impl Buffer<Uninitialized> {
    fn new() -> Self {
        Buffer {
            data: Vec::new(),
            _state: PhantomData,
        }
    }
    fn initialize(mut self, size: usize) -> Buffer<Initialized> {
        self.data.resize(size, 0);
        Buffer {
            data: self.data,
            _state: PhantomData,
        }
    }
}
impl Buffer<Initialized> {
    fn write(&mut self, offset: usize, data: &[u8]) {
        // Only available after initialization
        self.data[offset..offset + data.len()].copy_from_slice(data);
    }
}
```
### Pattern 14: Custom Derive with Derive Helpers
```rust
// Define a trait for serialization
trait Serialize {
    fn serialize(&self) -> Vec<u8>;
}
// Use helper attributes with custom derive
#[derive(Serialize)]
struct Config {
    #[serialize(rename = "timeout_ms")]
    timeout: Duration,
    #[serialize(skip)]
    internal_state: u64,
    #[serialize(with = "hex")]
    secret: Vec<u8>,
}
// Helper function for custom serialization
mod hex {
    pub fn serialize(bytes: &[u8]) -> String {
        bytes.iter()
            .map(|b| format!("{:02x}", b))
            .collect()
    }
}
```
### Pattern 15: Trait Specialization Pattern (Current Stable Workaround)
```rust
// Use trait bounds to specialize behavior
trait Process {
    fn process(&self) -> String;
}
// Generic implementation
impl<T: Display> Process for T {
    default fn process(&self) -> String {
        format!("Generic: {}", self)
    }
}
// Specialized for Copy types (would require specialization feature)
// Workaround: use separate traits
trait ProcessCopy {
    fn process_copy(&self) -> String;
}
impl<T: Copy + Display> ProcessCopy for T {
    fn process_copy(&self) -> String {
        format!("Copy type: {}", self)
    }
}
```
### Pattern 16: GATs (Generic Associated Types)
```rust
trait LendingIterator {
    type Item<'a> where Self: 'a;
    fn next(&mut self) -> Option<Self::Item<'_>>;
}
// Allows borrowing from iterator itself
struct WindowsMut<'data, T> {
    data: &'data mut [T],
    window_size: usize,
    pos: usize,
}
impl<'data, T> LendingIterator for WindowsMut<'data, T> {
    type Item<'a> = &'a mut [T] where Self: 'a;
    fn next(&mut self) -> Option<Self::Item<'_>> {
        if self.pos + self.window_size > self.data.len() {
            None
        } else {
            let slice = &mut self.data[self.pos..self.pos + self.window_size];
            self.pos += 1;
            Some(slice)
        }
    }
}
```
### Pattern 17: Attribute Macros for Boilerplate
```rust
// Attribute macro for automatic instrumentation
#[traced]
fn compute_hash(data: &[u8]) -> u64 {
    // Expands to:
    // fn compute_hash(data: &[u8]) -> u64 {
    //     let _span = tracing::span!(tracing::Level::TRACE, "compute_hash");
    //     let _guard =_ span.enter();
    //     // original body
    // }
    hash(data)
}
// Attribute macro for async retry logic
#[retry(times = 3, backoff = "exponential")]
async fn fetch_data(url: &str) -> Result<Data, Error> {
    // Macro wraps this in retry logic
    reqwest::get(url).await?.json().await
}
```
### Pattern 18: Procedural Macros for DSLs
```rust
// Define a mini-language for state machines
state_machine! {
    enum Connection {
        Disconnected {
            connect() -> Connecting,
        },
        Connecting {
            success() -> Connected,
            failure() -> Disconnected,
        },
        Connected {
            send(data: &[u8]) -> Connected,
            disconnect() -> Disconnected,
        },
    }
}
// Expands to type-safe state machine with compile-time transitions
```
### Pattern 19: Const Functions for Compile-Time Computation
```rust
const fn fibonacci(n: u32) -> u32 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}
// Computed at compile time
const FIB_10: u32 = fibonacci(10);
// Const constructors
struct Config {
    max_connections: usize,
    timeout_secs: u64,
}
impl Config {
    const fn new() -> Self {
        Config {
            max_connections: 100,
            timeout_secs: 30,
        }
    }
    const fn with_timeout(timeout: u64) -> Self {
        Config {
            max_connections: 100,
            timeout_secs: timeout,
        }
    }
}
// Static configuration computed at compile time
static CONFIG: Config = Config::with_timeout(60);
```
### Pattern 20: Phantom Data for Variance Control
```rust
use std::marker::PhantomData;
// Covariant over T (can substitute subtype)
struct Iter<'a, T> {
    ptr: *const T,
    end: *const T,
    _marker: PhantomData<&'a T>,  // Covariant in T
}
// Invariant over T (cannot substitute)
struct IterMut<'a, T> {
    ptr: *mut T,
    end: *mut T,
    _marker: PhantomData<&'a mut T>,  // Invariant in T
}
// Contravariant example (rare)
struct Consumer<T> {
    consume_fn: fn(T),
    _marker: PhantomData<fn(T)>,  // Contravariant in T
}
```
---
## MACRO MASTERY
### Declarative Macros - Repetition Patterns
```rust
// Repetition with separators
macro_rules! hash_map {
    ($($key:expr => $val:expr),* $(,)?) => {
        {
            let mut map = HashMap::new();
            $(map.insert($key, $val);)*
            map
        }
    };
}
// Use: let m = hash_map! { "a" => 1, "b" => 2 };
```
### Declarative Macros - Token Tree Munching
```rust
// Process tokens recursively
macro_rules! count_tokens {
    () => { 0 };
    ($head:tt $($tail:tt)*) => {
        1 + count_tokens!($($tail)*)
    };
}
// Use: const LEN: usize = count_tokens!(a b c d e);  // 5
```
### Declarative Macros - Internal Rules Pattern
```rust
macro_rules! builder {
    // Public interface
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        builder! { @struct $name { $($field: $ty,)* } }
        builder! { @impl $name { $($field: $ty,)* } }
    };
    // Internal rules (not callable by users)
    (@struct $name:ident { $($field:ident: $ty:ty,)* }) => {
        pub struct $name {
            $(pub $field: $ty,)*
        }
    };
    (@impl $name:ident { $($field:ident: $ty:ty,)* }) => {
        impl $name {
            pub fn new() -> Self {
                Self {
                    $($field: Default::default(),)*
                }
            }
        }
    };
}
```
### Attribute Macros - Function Transformation
```rust
// Simplified example structure
#[proc_macro_attribute]
pub fn measure_time(args: TokenStream, input: TokenStream) -> TokenStream {
    let func = parse_macro_input!(input as ItemFn);
    let func_name = &func.sig.ident;
    quote! {
        fn #func_name() {
            let start = std::time::Instant::now();
            let result = {
                #func  // Original function body
            };
            println!("Took {:?}", start.elapsed());
            result
        }
    }
}
```
### Derive Macros - Automatic Trait Implementation
```rust
// Simplified derive macro structure
#[proc_macro_derive(Builder, attributes(builder))]
pub fn derive_builder(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = input.ident;
    let builder_name = format_ident!("{}Builder", name);
    // Parse fields and generate builder
    quote! {
        impl #name {
            pub fn builder() -> #builder_name {
                #builder_name::default()
            }
        }
        pub struct #builder_name {
            // generated fields
        }
    }
}
```
---
## STDLIB PATTERNS TO STUDY
### Study These Files for Patterns
```bash
# Iterator design patterns
Read ~/RustProjects/forks/rust/library/core/src/iter/traits/iterator.rs
Read ~/RustProjects/forks/rust/library/core/src/iter/adapters/
# Option and Result patterns
Read ~/RustProjects/forks/rust/library/core/src/option.rs
Read ~/RustProjects/forks/rust/library/core/src/result.rs
# Marker traits and type system magic
Read ~/RustProjects/forks/rust/library/core/src/marker.rs
Read ~/RustProjects/forks/rust/library/core/src/ops/
# Conversion traits
Read ~/RustProjects/forks/rust/library/core/src/convert/mod.rs
# Format trait family
Read ~/RustProjects/forks/rust/library/core/src/fmt/mod.rs
# Macro implementations
Read ~/RustProjects/forks/rust/library/core/src/macros/mod.rs
Read ~/RustProjects/forks/rust/library/alloc/src/macros.rs
# Smart pointers
Read ~/RustProjects/forks/rust/library/alloc/src/boxed.rs
Read ~/RustProjects/forks/rust/library/alloc/src/sync.rs
Read ~/RustProjects/forks/rust/library/alloc/src/rc.rs
# Collections design
Read ~/RustProjects/forks/rust/library/alloc/src/vec/mod.rs
Read ~/RustProjects/forks/rust/library/std/src/collections/hash/map.rs
```
### Key Stdlib Patterns to Internalize
1. **Everything is an iterator** - Iterators compose, they don't allocate
2. **Types encode state** - Use the type system to prevent invalid operations
3. **Associated types over generics** - One implementation per type
4. **Const generics for zero-cost arrays** - No runtime overhead
5. **Marker traits for capabilities** - Send, Sync, Copy, Sized
6. **Extension traits** - Add methods to external types
7. **Sealed traits** - Prevent external implementation
8. **GATs for borrowing** - Lending iterators and complex lifetimes
9. **PhantomData for variance** - Control subtyping relationships
10. **Const functions** - Compile-time computation
---
## WHEN TO USE WHAT
| You Need | Use This | Not This |
|----------|----------|----------|
| Multiple similar types | Enum | Separate structs |
| One impl per type | Associated type | Generic type parameter |
| Zero-cost abstraction | Newtype pattern | Runtime checks |
| Compile-time size | Const generic | Vec<T> |
| State transitions | Typestate pattern | Runtime enum |
| Add methods to external types | Extension trait | Wrapper type |
| Prevent external impls | Sealed trait | Public trait |
| Boilerplate reduction | Declarative macro | Copy-paste |
| Complex codegen | Proc macro | Declarative macro |
| Compile-time values | const fn | static |
| Performance-critical | Inline/const fn | Normal fn |
---
## ANTI-PATTERNS FROM STDLIB STUDY
### Don't: Overuse Generics
```rust
// TOO GENERIC
fn process<T: Serialize + Deserialize + Clone + Debug>(item: T) { ... }
// BETTER: Be specific
fn process_config(config: &Config) { ... }
```
### Don't: Ignore Iterator Adapters
```rust
// BAD: Manual loops
let mut result = Vec::new();
for item in collection {
    if item > 5 {
        result.push(item * 2);
    }
}
// GOOD: Iterator chain
let result: Vec<_> = collection
    .iter()
    .filter(|&&x| x > 5)
    .map(|&x| x * 2)
    .collect();
```
### Don't: String-Based Typing
```rust
// BAD: Strings for everything
fn set_mode(mode: &str) { ... }
// GOOD: Enums for variants
enum Mode { Fast, Slow, Adaptive }
fn set_mode(mode: Mode) { ... }
```
### Don't: Derive Everything
```rust
// BAD: Unnecessary derives
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
struct Handle(u64);
// GOOD: Only what you need
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Handle(u64);
```
---
## FINAL WORKFLOW
**Before writing any Rust code:**
1. **Is this a state machine?** → Use typestate pattern
2. **Do I need multiple implementations?** → Use trait with associated types
3. **Is this a wrapper?** → Use newtype pattern
4. **Do I need compile-time sizes?** → Use const generics
5. **Is this repetitive boilerplate?** → Write a declarative macro
6. **Am I wrapping external types?** → Use extension trait
7. **Should external crates implement this?** → Make it public; otherwise seal it
**Always look at how stdlib solves similar problems before inventing your own solution.**