---
name: cpp-style
description: "Idiomatic modern C++ style guide. Prefer value semantics, RAII, and smart pointers. Use spans/string_view for non-owning access. Leverage concepts over SFINAE, ranges for pipelines, std::expected for recoverable errors, and jthread/stop_token for concurrency. Triggers: 'cpp', '.cpp/.hpp files', 'c++', 'modern cpp', 'cpp17', 'cpp20', 'cpp23', 'style', 'idiomatic', 'pattern', 'refactor', 'architecture', 'value semantics', 'span', 'ranges', 'concepts', 'expected', 'smart pointer', 'RAII', 'constexpr', 'modules'."
---
# Modern C++ Style Guide - Idiomatic Patterns
**Philosophy**: Write C++ that is safe by default, zero-cost where it matters, and expressive through the type system. Favor value semantics with move support, RAII for resource management, and explicit interfaces over implicit contracts. Make illegal states unrepresentable at compile time when possible.
**Reference Repositories**:
- `~/CppProjects/forks/llvm-project/llvm/include/llvm/` - LLVM coding standards & utilities
- `~/CppProjects/forks/abseil/absl/` - Abseil production-grade patterns
- `~/CppProjects/forks/boostorg/` - Boost library patterns
- `~/CppProjects/forks/isocpp/CppCoreGuidelines/` - Official C++ Core Guidelines
---
## CORE PRINCIPLES
### 1. RAII Over Manual Resource Management
```cpp
// BAD: Manual new/delete, error-prone cleanup
void process(const char* data) {
    auto buffer = new uint8_t[SIZE];
    copy_data(buffer, data);
    if (error_condition) return; // LEAK!
    use_buffer(buffer);
    delete[] buffer; // Always reached? Maybe not.
}
// GOOD: RAII wraps lifetime in destructor
void process(span<const uint8_t> data) {
    vector<uint8_t> buffer; // Automatic cleanup, exception-safe
    buffer.resize(data.size());
    ranges::copy(data, buffer.begin());
    if (error_condition) return; // Clean exit
    use_buffer(span{buffer});
}
```

### 2. Value Semantics + Move Over Shared Ownership
```cpp
// BAD: Premature shared_ptr, unnecessary copies
shared_ptr<Data> create_data(const string& name) {
    auto p = make_shared<Data>(name); // Heap allocation + ref counting
    return p;
}
Data get_data() { 
    static shared_ptr<Data> cache; // Global singleton anti-pattern
    return *cache; 
}
// GOOD: Value types with move, caches via unique_ptr or flat map
struct Data { string name; int id; };
vector<Data> fetch_all(); // Return by value, rely on RVO/move
map<string, unique_ptr<Data>> cache; // Explicit ownership boundary
```

### 3. Spans & String_View Over Raw Pointers
```cpp
// BAD: Pointer + length dance, easy to mismatch
void render(const char* text, size_t len);
render(buf, strlen(buf)); // What if buf isn't null-terminated?
// GOOD: Span enforces count semantics, bounds-checked optional
void render(span<const uint8_t> pixels); // Fixed-size image data
void print(string_view message);          // Zero-copy string slice
```

### 4. Concepts Over SFINAE/Enable_If
```cpp
// BAD: SFINAE soup, unreadable constraints
template<typename T, typename = enable_if_t<is_integral_v<T>>>
T square(T x) { return x * x; }

// GOOD: Readable, composable, better error messages
template<integral T>
T square(T x) { return x * x; }
// Or with custom concept
template<typename T>
concept Numeric = is_arithmetic_v<T>;
template<Numeric T>
T square(T x) { ... }
```

### 5. Expected For Recoverable Errors, Exceptions For Exceptional
```cpp
// BAD: Exceptions everywhere (costly, hard to reason about locally)
int parse_int(const string& s) {
    try { return stoi(s); } catch (...) { return -1; } // Swallowing!
}
// GOOD: Expected makes success/failure explicit in return type
expected<int, ParseError> parse_int(string_view s);
auto result = parse_int(input);
if (result.has_value()) { use(result.value()); }
else { handle_error(result.error()); }
```
---
## PATTERN CATALOG
### Pattern 1: Smart Pointer Discipline
Prefer `unique_ptr` unless sharing is explicit. Use `make_unique`/`make_shared`.
```cpp
// Factory returns owned pointer
unique_ptr<Connection> ConnectionPool::acquire() {
    return make_unique<Connection>(/*...*/);
}
// Borrowed reference pattern
class Cache {
public:
    void put(key_type k, unique_ptr<Value> v); // Transfers ownership
    const Value* get(key_type k) const;        // Borrows, never owns
private:
    unordered_map<key_type, unique_ptr<Value>> store_;
};
```

### Pattern 2: Typestate via Classes
Encode state machines directly in the class hierarchy or tag dispatch.
```cpp
struct Uninit {};
struct Init {};
struct Running {};
template<typename State>
class Server { /* ... */ };

using ServerInit = Server<Uninit>;
using ServerReady = Server<Init>;
using ServerActive = Server<Running>;

ServerReady ServerInit::configure() && {
    validate_config();
    return ServerReady{*this};
}
ServerActive ServerReady::start() && {
    launch_threads();
    return ServerActive{*this};
}
// Compiler enforces: must configure() before start()
```

### Pattern 3: Builder with Compile-Time Guarantees
Use CRTP or tagged constructors for required/optional fields.
```cpp
class RequestBuilder {
    string host_;
    optional<string> path_;
    optional<Duration> timeout_;
public:
    RequestBuilder& host(string_view h) { host_ = h; return *this; }
    RequestBuilder& path(string_view p) { path_ = p; return *this; }
    RequestBuilder& timeout(Duration d) { timeout_ = d; return *this; }
    
    Request build() {
        if (!host_) throw invalid_argument("host required");
        return Request{move(host_), move(path_), move(timeout_)};
    }
};
// Usage fluent but validated only at build():
auto req = RequestBuilder{}
    .host("api.example.com")
    .path("/v1/data")
    .timeout(5s)
    .build();
```

### Pattern 4: Extension Traits via ADL & Free Functions
Add functionality without inheritance using argument-dependent lookup.
```cpp
namespace details {
    struct extension_tag {};
}

template<typename T>
concept Streamable = requires(T t) {
    { std::cout << t } -> std::same_as<std::ostream&>;
};

template<Streamable T>
std::ostream& operator<<(std::ostream& os, [[maybe_unused]] details::extension_tag, T&& val) {
    // Generic formatting logic
    return os << format_to_n(os, ..., "{}", val);
}

// Usage via ADL
std::cout << details::extension_tag{}, my_custom_type;
```

### Pattern 5: Compile-Time Programming with constexpr & consteval
Move computation off the critical path.
```cpp
constexpr uint64_t hash_string(string_view s) {
    uint64_t h = 14695981039346656037ULL;
    for (char c : s) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}
// Evaluated at compile time:
static_assert(hash_string("config_key") == 0x8f3a...);
consteval uint64_t compute_runtime_hash(string_view s) {
    // Must be evaluated at compile-time or compiler rejects
    return hash_string(s);
}
if consteval {
    // Branch selected at compile-time
    return compile_time_algorithm(data);
} else {
    return runtime_algorithm(data);
}
```

### Pattern 6: Range Pipelines & Views
Replace manual loops with composable range expressions.
```cpp
// BAD: Multiple passes, temporary allocations
vector<int> even_squares;
for (int i : numbers) {
    if (i % 2 == 0) {
        even_squares.push_back(i * i);
    }
}
sort(even_squares.begin(), even_squares.end());
even_squares.erase(unique(even_squares.begin(), even_squares.end()), even_squares.end());

// GOOD: Single pass view pipeline, lazy evaluation
auto result = numbers 
    | views::filter([](int n) { return n % 2 == 0; })
    | views::transform([](int n) { return n * n; })
    | ranges::to<vector>;
// Or with projection (C++23):
ranges::sort(unique_numbers, {}, &Element::id);
```

### Pattern 7: Structured Bindings & Heterogeneous Lookup
Clean destructuring and O(log n) lookups.
```cpp
// Structured bindings unpack maps, pairs, tuples naturally
for (auto [key, value] : container) { /* ... */ }
auto [it, success] = my_set.insert(item);
if (success) { /* inserted */ }

// Heterogeneous lookup avoids allocations/casts
unordered_map<KeyType, ValueType, KeyHash, KeyEqual> cache;
// Where KeyHash/keyEqual use transparent operator()
auto it = cache.find(string_view("dynamic_key")); // No std::string alloc!
```

### Pattern 8: Cooperative Concurrency with jthread & stop_token
Explicit cancellation instead of pthread cancel/spin waiting.
```cpp
#include <thread>
#include <chrono>

void worker(stop_token token) {
    while (!token.stop_requested()) {
        // Do work
        this_thread::sleep_for(100ms); // Check frequently
    }
    log("Worker shut down cooperatively");
}

int main() {
    jthread t(worker); // Automatically stops/joins on destruction
    t.request_stop();  // Signals worker loop
} // t joins here automatically
```

### Pattern 9: Sealed Interfaces via Private Constructors
Prevent external implementation while keeping polymorphism.
```cpp
class Serializer {
public:
    virtual ~Serializer() = default;
    virtual string serialize(const Data&) = 0;
protected:
    Serializer() = default; // Prevent stack/heap construction
    friend class SerializerFactory; // Only factory can instantiate
private:
    Serializer(const Serializer&) = delete; // Disable copy
};

// External code must use factory or interface method
unique_ptr<Serializer> create_json_serializer();
unique_ptr<Serializer> create_protobuf_serializer();
```

### Pattern 10: Tag Dispatch for Algorithm Specialization
Avoid template bloat while maintaining compile-time polymorphism.
```cpp
struct fast_path_tag {};
struct safe_path_tag {};

template<typename T>
constexpr bool supports_fast_path = is_v<CPU_FEATURE_SSE42, T>;

template<typename T>
process_data(T&& input, fast_path_tag) {
    // SSE/AVX optimized version
}
template<typename T>
process_data(T&& input, safe_path_tag) {
    // Portable fallback
}
// Auto-select at compile time
template<typename T>
void process(T&& input) {
    if constexpr (supports_fast_path<T>) {
        process_data(std::forward<T>(input), fast_path_tag{});
    } else {
        process_data(std::forward<T>(input), safe_path_tag{});
    }
}
```
---
## DOCUMENTATION & COMMENTING STANDARDS
### Doxygen Docstring Format (Preferred)
Modern C++ relies on structured documentation for IDE integration, CI checks, and public API consumption. Follow this strict template for all public interfaces.

#### Function/Method Template
```cpp
/**
 * @brief [Short one-line description. Imperative verb phrase.]
 *
 * @details [Optional deeper explanation. Assumptions, context, and algorithmic
 *          notes go here. Keep paragraphs concise.]
 *
 * @param[in] param_name Description of input parameter. Specify direction.
 * @param[out] out_param Description of output parameter, if any.
 * @return [Description of return value. E.g., `true` on success, index, or expected.]
 * @pre [Required conditions before calling, e.g., "caller must own the buffer."]
 * @post [Guaranteed conditions after call, e.g., "buffer will contain valid header."]
 * @throws [Exception types guaranteed or possibly thrown, with context.]
 * @note [Important caveats, performance characteristics, or ABI stability notes.]
 */
```

#### Class/Struct Template
```cpp
/**
 * @class ConfigParser
 * @brief Parses configuration files and validates schema compliance.
 * @details Thread-safe, single-threaded alternative described below. Uses recursive descent parsing.
 * @remark Not suitable for streaming or >2GB files due to memory model.
 */
```

#### Enum/Bits Template
```cpp
/**
 * @enum LogSeverity
 * @brief Precedence levels for application logging.
 * @note Values are ordered; higher enum value implies more verbose output.
 */
enum class LogSeverity { Debug, Info, Warning, Error, Fatal };

/**
 * @var LogLevelMask
 * @brief Bitmask combining LogSeverity flags. See LogCategory docs.
 */
```

### Inline Comment Rules
Follow these best practices to keep code readable and maintainable without cluttering the AST or IDE tooltips.

1. **Avoid Redundant Comments**: Never repeat what the signature/type already expresses. Explain *why*, not *what*.
   ```cpp
   // BAD: increments counter by one
   counter++;
   // GOOD: compensates for off-by-one in legacy protocol handshake
   counter++;
   ```
2. **Refactor Instead of Commenting**: If you need >3 lines of comments to clarify a block, extract it or simplify it first.
3. **Clarify Unsafe/Casting Operations**: Every `reinterpret_cast`, `const_cast`, or raw pointer arithmetic must have a `// SAFETY:` block explaining invariant preservation.
4. **Explain Unusual Optimizations**: SIMD intrinsics, lock-free primitives, or specialized allocators require citation and correctness justification.
5. **Cite External Sources**: For adapted algorithms (FNV, xxHash, LRU eviction), include links to the original paper/specification and relevant discussions.
6. **Link Bug References**: Document regression fixes explicitly with issue/ticket references.
   ```cpp
   // Fixes crash on empty input under concurrent modification.
   // https://github.com/project/repo/issues/1842
   ```
7. **Mark Incomplete Implementations**: Use `TODO: @username reason deadline` format. Mark `FIXME:`, `HACK:`, or `XXX:` for known defects or quick fixes.
8. **Document Thread Safety**: Explicitly state whether methods are `@threadsafe`, reentrant, or require external synchronization.
9. **No Dead Code Comments**: Remove commented-out code entirely. VCS preserves history.

### Documentation Workflow
**Before writing documentation, understand the behavioral logic, memory model, and thread-safety contract.** Recursively verify dependencies until invariants are clear. If parameters have ambiguous lifetimes or ownership semantics, prompt the user or consult the module interface.

**Auto-documentation Checklist:**
- [ ] Does every public method have `@brief`, `@param` (direction), `@return`, and `@throws`?
- [ ] Are `@pre`/`@post` conditions explicit for mutation methods?
- [ ] Is `noexcept` usage justified by the exception specification?
- [ ] Are `span`/`string_view` lifetimes documented relative to caller-owned storage?
- [ ] Is thread-safety status (`@threadsafe` or not) stated?
---
## ANTI-PATTERNS TO AVOID
### 1. Raw Pointer Ownership Ambiguity
```cpp
// BAD: Who deletes? Documented? Assumed?
void init(Config* cfg) { config_ = cfg; } // Leaks on reset
// GOOD: Explicit semantics
void init(shared_ptr<Config> cfg);      // Sharing allowed
void init(unique_ptr<Config> cfg);      // Transfer ownership
void init(config_ptr cfg);              // Alias for unique_ptr
```

### 2. Primitive Obsession & Stringly-Typed IDs
```cpp
// BAD: Confusable identifiers
struct User { int user_id; int order_id; };
// GOOD: Strong typedefs (C++20 designated initializers help)
struct UserId : strong_typedef<int> { using strong_typedef::strong_typedef; };
struct OrderId : strong_typedef<int> { using strong_typedef::strong_typedef; };
// Compiler catches: User{UserId{1}, OrderId{2}} vs mixed up
```

### 3. Ignoring Move Semantics & Copy Elision
```cpp
// BAD: Unnecessary copies, missing noexcept
MyClass clone(const MyClass& src) {
    MyClass dest(src); // Copy!
    return dest;       // NRVO might not trigger
}
// GOOD: Move-aware, noexcept-guaranteed
MyClass clone(const MyClass& src) { return src; } // Perfect RVO
MyClass(MyClass&& other) noexcept = default; // Enable fast transfers
```

### 4. Global State & Static Initialization Order Fiasco
```cpp
// BAD: Untamed singletons, undefined initialization order
Config& global_config() {
    static Config cfg; // OK but tricky across DSO boundaries
    return cfg;
}
// GOOD: Dependency injection, explicit lifecycle
class Application {
    void configure(Config c) { config_ = move(c); }
    void run() { /* use config_ */ }
    Config config_;
};
```

### 5. Over-Using Templates When Polymorphism Fits
```cpp
// BAD: Template bloat, huge binaries, slow compile times
template<typename W>
void draw(w::Renderer& r, w::Shape s) { /* ... */ }
draw<OpenGL>(gl_ctx, triangle);
draw<Vulkan>(vk_cmd, triangle);
// GOOD: Polymorphic dispatch when types are heterogeneous/dynamic
void draw(Renderer& r, Shape& s) { s.draw(r); }
// Use templates for performance-critical homogeneous paths only
```
---
## LOOKUP COMMANDS
### Find Smart Pointer & Memory Patterns
```bash
# How does unique_ptr work internally?
Read ~/CppProjects/forks/llvm-project/libcxx/include/memory
rg "^template.*class unique_ptr" -A 10
# Best practices for ownership transfer
rg "unique_ptr.*release\(\)|transfert" ~/CppProjects/forks/abseil/absl/memory/ -l
```

### Find Ranges & Views Patterns
```bash
# How does std::views compose?
rg "struct filter_view|struct transform_view" ~/CppProjects/forks/llvm-project/libcxx/include/__ranges/ -l
# Real-world range usage
rg "ranges::|views::" ~/CppProjects/forks/llvm-project/llvm/include/llvm/Support/ --type cpp | head -20
```

### Find Concurrency Primitives
```bash
# Jthread & stop_token implementation
rg "class jthread|class stop_source" ~/CppProjects/forks/llvm-project/libcxx/include/ -l
# Latch/Barrier usage patterns
rg "std::latch|std::barrier" ~/CppProjects/forks/boostorg/thread/src/ -l
```

### Find Core Guidelines References
```bash
# Ownership rules
rg "C.40|C.42|C.148" ~/CppProjects/forks/isocpp/CppCoreGuidelines/ -l
# Performance rules
rg "F.3|ES.44|ST.0" ~/CppProjects/forks/isocpp/CppCoreGuidelines/ -l
```
---
## WHEN TO APPLY THESE PATTERNS
| Situation | Pattern to Use | Not This |
|-----------|----------------|----------|
| Exclusive ownership | `unique_ptr`, pass by value | `new`/`delete`, raw pointers |
| Shared ownership | `shared_ptr` (explicit), weak refs | Implicit copying of large objects |
| Non-owning read access | `span`, `string_view` | `const T*`, `size_t len` pairs |
| Compile-time validation | `constexpr`, `consteval`, `if consteval` | Runtime asserts for invariant checks |
| Complex configuration | Builder with fluent API | 10-parameter constructors |
| Heterogeneous algorithms | Polymorphism (vtables) | Monolithic templates |
| Homogeneous hot paths | Templates, ranges, SIMD intrinsics | Virtual dispatch |
| Error handling (common) | `std::expected`, return codes | Exceptions for control flow |
| Error handling (rare) | Exceptions, `try`/`catch` | Returning `false` silently |
| State machine enforcement | Typestate classes, enum + transition functions | Integer flags + switch |
| Build optimization | C++20 modules, header units, precompiled headers | Endless include chains |
| Thread lifecycle | `std::jthread`, `stop_token` | Manual thread joining, spin locks |

---
## WORKFLOW
1. **Before writing constructors**: Ask "Can parameters be span/string_view?"
2. **Before returning pointers**: Ask "Does this own, share, or borrow?"
3. **Before templates**: Ask "Is this heterogeneous or performance-critical?"
4. **Before raw loops**: Ask "Could this be a range pipeline?"
5. **Before globals/singletons**: Ask "Can dependency injection work here?"
6. **Before exceptions**: Ask "Is this a normal program outcome or exceptional?"
7. **Before new/delete**: Ask "What's the RAII wrapper or smart pointer equivalent?"
8. **Before finalizing API**: Apply `DOCUMENTATION & COMMENTING STANDARDS` checklist.
**Always consult C++ Core Guidelines (`https://isocpp.github.io/CppCoreGuidelines`) before making architectural decisions.**
---
## ADVANCED PATTERNS FROM STL & ABSEIL
### Pattern 11: Heterogeneous Lookup & Transparent Comparators
```cpp
struct Person { string name; int age; };
using PersonMap = unordered_map<string, Person, 
    hash<string>, equal_to<>, 
    decltype(PriorityQueueCompare{}), // Custom hash/equal
    allocator<pair<const string, Person>>>;
// Enable transparent lookup: find(string_view) works without alloc
struct PersonKeyHash {
    using is_transparent = void;
    size_t operator()(string_view sv) const { return hash<string_view>{}(sv); }
    size_t operator()(const string& s) const { return hash<string>{}(s); }
};
```

### Pattern 12: Policy-Based Design & CRTP Mixins
```cpp
template<typename Derived>
class Loggable { // CRTP mixin
public:
    void log() const { static_cast<const Derived*>(this)->format_log(std::cerr); }
};
class MyService : public Loggable<MyService> {
    void format_log(ostream&) const; // Implementation provided by Derived
};
// Zero-overhead abstraction, no vtable needed
```

### Pattern 13: Constexpr Containers & Compile-Time Parsing
```cpp
// Compile-time vector-like structure (C++23 approach)
struct ConfigParser {
    static constexpr array<int, 100> parse(string_view raw) {
        array<int, 100> result{};
        size_t i = 0;
        while (i < raw.size() && i < 100) {
            // Parse integer
            int val = 0;
            while (i < raw.size() && isdigit(raw[i])) {
                val = val * 10 + (raw[i] - '0');
                ++i;
            }
            result[i] = val;
            ++i; // skip delimiter
        }
        return result;
    }
};
constexpr auto parsed_config = ConfigParser::parse("1,2,3,4,5");
```

### Pattern 14: Modules vs Headers Decision Framework
```cpp
// Module interface unit (.cppm)
export module math.core;
import <vector>;
import <optional>;

export namespace math {
    template<typename T> concept Number = is_arithmetic_v<T>;
    export template<Number T> T add(T a, T b) { return a + b; }
}

// Module implementation unit
module math.core; // Continues definition
// Heavy internals, inline definitions, template instantiation control
```
**Rule**: Modules for library boundaries, header units for third-party headers. Keep internal implementation hidden.

### Pattern 15: Deduction Guides & CTAD
```cpp
template<typename K, typename V>
class PairCache { /*...*/ };
// Automatic deduction prevents verbose syntax
PairCache pc{string{"key"}, 42}; // Compiles as PairCache<string, int>
// Custom guides for type normalization
template<typename T>
PairCache(T*, T*) -> PairCache<std::decay_t<T>, std::decay_t<T>>;
```

### Pattern 16: Expected Monad Operations
```cpp
// Functional composition for error flows
auto load_config = []() -> expected<Config, IOErr> { /*...*/ };
auto validate = [](Config c) -> expected<Config, ValidationError> { /*...*/ };
auto apply = [](Config c) -> expected<Result, AppErr> { /*...*/ };

// Chain without nested ifs (C++23 helper or monadic combinator)
expected<Result, variant<IOErr, ValidationError, AppErr>> res;
res = load_config().and_then(validate).and_then(apply);
if (auto e = res.error(); e) { /* handle unified error */ }
```

### Pattern 17: Heterogeneous Container Views
```cpp
// Slice a container without copying
vector<int> data = {1,2,3,4,5,6,7,8,9,10};
span<const int> window(&data[3], 4); // {4,5,6,7}
window[0] = 99; // Modifies original
// Subrange views (C++20)
ranges::subrange r{data.begin() + 2, data.begin() + 6};
```

### Pattern 18: Alignment & Packing Awareness
```cpp
// Alignas for SIMD/cache line optimization
alignas(64) struct alignas(64) CacheLineAligned {
    atomic<int> counter;
    padding<56> unused; // Avoid false sharing
};
// Pack structs explicitly when binary layout matters
struct __attribute__((packed)) Header {
    uint16_t magic;
    uint8_t version;
}; // Use carefully! Slower accesses on some architectures
```
---
## MACRO MASTERY
### Debug Logging Macros
```cpp
#ifdef DEBUG_MODE
#define LOG_DEBUG(fmt, ...) \
    fprintf(stderr, "[DEBUG] %s:%d %s(): " fmt "\n", \
            __FILE__, __LINE__, __func__, ##__VA_ARGS__)
#else
#define LOG_DEBUG(fmt, ...) ((void)0)
#endif
// Use: LOG_DEBUG("Processing batch %zu items", batch_size);
```

### Type Assertions & Static Checks
```cpp
// Compile-time type validation
#define STATIC_ASSERT_TYPE(T, Concept) \
    static_assert(Concept<T>, #T " does not satisfy " #Concept)
STATIC_ASSERT_TYPE(int, integral);
STATIC_ASSERT_TYPE(string, Printable);
```

### Safe Cast Wrapper
```cpp
template<typename Target, typename Source>
Target safe_downcast(Source* ptr) {
    static_assert(is_base_of_v<Target, Source>);
    assert(ptr);
    Target* result = dynamic_cast<Target*>(ptr);
    assert(result);
    return result;
}
```
---
## STDLIB PATTERNS TO STUDY
### Study These Files for Patterns
```bash
# Smart pointer design & deleter customization
Read ~/CppProjects/forks/llvm-project/libcxx/include/memory
rg "^template.*class unique_ptr" -A 50
# Span/StringView bounds checking patterns
Read ~/CppProjects/forks/llvm-project/libcxx/include/__span/span
Read ~/CppProjects/forks/llvm-project/libcxx/include/__string/string_view
# Range view implementations
ls ~/CppProjects/forks/llvm-project/libcxx/include/__ranges/
# Expected/result error handling
Read ~/CppProjects/forks/llvm-project/libcxx/include/__expected/expected
# Concurrent primitives
Read ~/CppProjects/forks/llvm-project/libcxx/include/__mutex_base
# Tuple/Pair structured binding helpers
Read ~/CppProjects/forks/llvm-project/libcxx/include/tuple
```

### Key Stdlib Patterns to Internalize
1. **RAII is mandatory** - Wrappers in destructor, never leak resources
2. **Value semantics first** - Copies/moves are cheap for small types
3. **Views don't own** - `span`/`string_view` are parameter passing tools
4. **Concepts replace SFINAE** - Better diagnostics, compositional
5. **Ranges compose lazily** - Pipeline operators `|`, defer computation
6. **Expected > Exceptions** for domain logic - Explicit control flow
7. **jthread > raw threads** - Automatic join & cooperative cancellation
8. **CTAD + deduction guides** - Reduce template verbosity
9. **Constexpr evaluation** - Push work to compile time when possible
10. **Modules > Headers** for library boundaries - Faster builds, cleaner encapsulation

---
## WHEN TO USE WHAT
| You Need | Use This | Not This |
|----------|----------|----------|
| Temporary read access | `span<T>` / `string_view` | `const T*` + length |
| Owned exclusive object | `unique_ptr<T>` or value | `new`/`malloc` |
| Shared ownership | `shared_ptr<T>` + `weak_ptr` cycles | Manual refcounting |
| Compile-time validation | `static_assert`, `if constexpr` | Runtime checks |
| Configuration building | Fluent builder class | Long constructor lists |
| Heterogeneous collections | `vector<unique_ptr<Base>>` | `void*` arrays |
| Hot path homogeneous ops | Templates + ranges + SIMD | Virtual dispatch |
| Recoverable failures | `std::expected<T, E>` | Exceptions for flow |
| Rare/unrecoverable | `throw std::runtime_error` | Returning error codes everywhere |
| Multi-thread coordination | `jthread`, `stop_token`, `latch`, `barrier` | Spin loops, `pthread_cancel` |
| Library API stability | C++20 Modules or opaque PIMPL | Exposing STL containers in public headers |

---
## FINAL WORKFLOW
**Before writing any C++ code:**
1. **Resource lifetime?** → RAII wrapper or smart pointer
2. **Passing large data?** → Pass by value (move) or `span`/`string_view`
3. **Complex logic branching on types?** → Concepts + template specialization
4. **Multiple similar algorithms?** → Range pipelines or function pointers/vtables
5. **Stateful object lifecycle?** → Typestate classes or explicit state enums + transitions
6. **Error likely & common?** → `std::expected` return type
7. **Template-heavy compile times?** → Modules, forward declarations, include guards
8. **Multi-threaded?** → `jthread` + `stop_token` + lock-free basics when appropriate
**Always benchmark with `-O3 -march=native -flto` before optimizing, and profile before guessing bottlenecks.**