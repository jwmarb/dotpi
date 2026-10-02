---
name: python-style
description: "Idiomatic Python style guide. Prefer Pydantic/dataclasses over plain dicts, Protocols over ABCs, type hints everywhere, pathlib over os.path. Zero-magic where possible, explicit validation at boundaries. Triggers: 'python', '.py files', 'type hint', 'pydantic', 'dataclass', 'protocol', 'design', 'refactor', 'error handling', 'best practice', 'clean architecture'."
---
# Python Style Guide - Idiomatic Patterns
**Philosophy**: Write Python like a senior engineer. Strong typing + runtime validation. Explicit > implicit. Favor simple functions and dataclasses over deep class hierarchies. Validate inputs at boundaries, trust invariants internally.
**Reference Repositories**:
- `https://docs.python.org/3/library/` - Standard library patterns
- `https://docs.pydantic.dev/latest/` - Validation & data modeling
- `https://typing.readthedocs.io/` - Advanced typing patterns
- `https://github.com/astral-sh/ruff` / `https://github.com/psf/black` - Formatting/Linting rules
---
## CORE PRINCIPLES
### 1. Types + Runtime Validation (The Boundary Rule)
Static types prevent logic errors; runtime validation prevents bad data. Use them together.
```python
# BAD: No validation, dynamic typing
def create_user(data):
    user = User(**data)  # Crashes if 'email' missing or invalid
    return user

# GOOD: Type hints + Pydantic/Dataclass at boundary
from pydantic import BaseModel, EmailStr
class CreateUserInput(BaseModel):
    name: str
    email: EmailStr
    age: int
    role: Literal["admin", "user", "viewer"] = "user"

def create_user(data: dict) -> User:
    input_data = CreateUserInput.model_validate(data)  # Raises ValidationError on bad data
    return User(name=input_data.name, email=input_data.email)
```

### 2. Protocols Over Deep Inheritance Hierarchies
Prefer structural subtyping (Protocols) over multiple inheritance or large class trees. Python is duck-typed anyway.
```python
# BAD: Rigid class hierarchy
class Animal: ...
class Mammal(Animal): ...
class FlyingMammal(Mammal): ...
class Bat(FlyingMammal): ...  # Can't reuse Flyable elsewhere

# GOOD: Protocol for capability
from typing import Protocol
class Flyable(Protocol):
    def fly(self) -> None: ...

class Bird:
    def fly(self) -> None: print("flapping")

class Plane:
    def fly(self) -> None: print("wings level")

# Function works with anything that implements the protocol
def deploy_aircraft(entity: Flyable) -> None: entity.fly()
```

### 3. Pathlib Over `os.path`
Modern file system paths are objects, not strings. Compose operations cleanly.
```python
# BAD: String concatenation
path = "/".join([base_dir, filename])
if os.path.exists(path): ...

# GOOD: Path objects
from pathlib import Path
config_path = base_dir / "config.yaml"
if config_path.is_file(): ...
content = config_path.read_text()
```

### 4. EAFP Over LBYL
"Ask forgiveness, not permission." Check existence after attempting, not before. Cleaner control flow.
```python
# BAD: Look Before You Leap
if key in my_dict:
    value = my_dict[key]
else:
    value = "default"

# GOOD: Exception Handling
try:
    value = my_dict[key]
except KeyError:
    value = "default"
```

### 5. Explicit Dependency Injection
Avoid global singletons and hidden imports. Pass dependencies explicitly for testability and clarity.
```python
# BAD: Global singleton
def do_work():
    db = get_global_db()  # Hard to test, hidden coupling

# GOOD: Explicit parameters (or factory closures)
def do_work(db: Database | None = None):
    if db is None: db = get_prod_db()
    # ...
```

---
## DOCUMENTATION STANDARDS
### 1. PEP 257 Docstrings
Every function, class, module, and public method needs a docstring. Follow PEP 257 strictly. Use Google-style formatting for readability and modern toolchain compatibility.
```python
def process_transactions(transactions: list[Transaction], cutoff_date: date) -> dict[str, Decimal]:
    """
    Process financial transactions, filtering by cutoff date and aggregating totals.
    
    Precondition:
        - All transaction dates must be timezone-aware or naive consistently.
        - `cutoff_date` must not be in the future relative to system clock.
        
    Postcondition:
        - Returns a dictionary mapping account IDs to aggregated transaction totals.
        - Original input list is unmodified.
        
    Args:
        transactions: List of Transaction objects to process.
        cutoff_date: Date threshold for inclusion. Transactions on this date are included.
        
    Returns:
        A mapping of account IDs to their net transaction amounts.
        
    Raises:
        ValueError: If any transaction has an invalid currency code.
        TypeError: If transactions is not a list or contains non-Transaction items.
    """
```
**Rules:**
- Avoid ambiguous types (`object`, `Any`, `unknown`). If ambiguity exists, prompt the user or look up the exact type definition.
- Document assumptions, context, and side effects.
- Keep it concise but exhaustive regarding behavior.

### 2. Inline Comments: Context, Not Redundancy
Do not repeat what the code says. Explain *why*. Refactor instead of commenting around complex logic.
```python
# BAD: Redundant
i += 1  # Increment i
result = data.get('key')  # Get key from data

# GOOD: Explains rationale / constraints
result = data.get('key')  # Default to empty string to avoid KeyError in legacy payload handling
# Offload CPU-bound sorting to thread pool to keep event loop responsive
loop.run_in_executor(None, sort_heavy_data, raw_items)
```
**Best Practices:**
- **Avoid redundancy:** Don't state the obvious. Provide additional context or rationale behind decisions.
- **Refactor > Comment:** If you need extensive comments to clarify code, simplify the code first.
- **Clarify, don't confuse:** Ensure comments make the code clearer; if not, remove or rewrite them.
- **Explain unusual code:** Provide context for non-obvious optimizations, workarounds, or domain-specific shortcuts.
- **Cite external sources:** For copied algorithms or specs, include links to the original source and relevant discussions.
- **Document bug fixes:** Include comments detailing fixes, referencing issues or bug reports when applicable.
- **Mark incomplete implementations:** Use standard markers (`TODO:`, `FIXME:`, `BROKEN:`) with additional details.

### 3. Type Hints as Living Documentation
Modern Python relies heavily on type hints. They serve as inline documentation. Pair them with docstrings for runtime contracts.
```python
# Bad: Loses all safety
def parse_config(path: Path) -> dict[str, Any]: ...

# Good: Precise generics + focused docstring
def parse_config(path: Path) -> ConfigDict | None: 
    """Attempts to load YAML config. Returns None if file is missing."""
    ...
```

---
## PATTERN CATALOG
### Pattern 1: Pydantic Models as Contracts
Pydantic v2 is the standard for API payloads, configs, and data transfer objects. Validates & serializes automatically.
```python
from pydantic import BaseModel, Field, ConfigDict

class DatabaseConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")  # Fail fast on unknown keys
    host: str
    port: int = Field(default=5432, ge=1, le=65535)
    credentials: dict[str, str] | None = None
    
    @property
    def connection_string(self) -> str:
        prefix = f"{self.credentials.get('user', '')}:" if self.credentials else ""
        return f"postgres://{prefix}@{self.host}:{self.port}/mydb"
```
**Reference**: `https://docs.pydantic.dev/latest/concepts/models/`

### Pattern 2: Distinct Types for IDs (NewTypes)
Avoid primitive obsession. Wrap primitives to catch swapping bugs at compile time.
```python
from typing import NewType
UserId = NewType("UserId", int)
OrderId = NewType("OrderId", int)

def get_user(user_id: UserId) -> User: ...
def cancel_order(order_id: OrderId) -> None: ...

# get_user(OrderId(1))  # Type checker error! Won't swap by accident
```

### Pattern 3: Match/Case for Complex Control Flow
Replace nested `if/elif` chains with structural pattern matching (Python 3.10+).
```python
# BAD: Long elif chain
def handle_event(event_type: str, payload: dict) -> None:
    if event_type == "user_created": process_new_user(payload)
    elif event_type == "order_placed": process_order(payload)
    elif event_type == "payment_failed": handle_failure(payload)

# GOOD: Structural pattern matching
def handle_event(event_type: str, payload: dict) -> None:
    match event_type, payload:
        case ("user_created", {"id": uid, "email": email}):
            process_new_user(uid, email)
        case ("order_placed", {"total": t}) if t < 0:
            raise ValueError("Negative total")
        case ("order_placed", data):
            process_order(data)
        case _:
            logger.warning(f"Unhandled event: {event_type}")
```

### Pattern 4: Context Managers for Resource Lifecycle
Explicit setup/teardown using `contextlib` or `with`. Prevents leaks on exceptions.
```python
from contextlib import contextmanager
import sqlite3

@contextmanager
def get_db_connection(dsn: str):
    conn = sqlite3.connect(dsn)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

# Usage ensures cleanup even on exceptions
with get_db_connection("file:memdb?mode=memory") as db:
    cursor = db.cursor()
    cursor.execute("SELECT * FROM users")
```

### Pattern 5: Frozen Dataclasses for Immutability
Use `dataclass(frozen=True)` for DTOs/configs that shouldn't change. Adds memory optimization with `slots=True`.
```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)  # slots=True saves memory in Python 3.10+
class Point:
    x: float
    y: float
    
    def distance_to(self, other: "Point") -> float:
        return ((self.x - other.x)**2 + (self.y - other.y)**2)**0.5

# p = Point(1, 2); p.x = 3  # FrozenInstanceError! Safe from mutation
```

### Pattern 6: Factory Methods (Smart Constructors)
Don't put complex construction logic in `__init__`. Centralize defaults and validation.
```python
from datetime import date

class Subscription:
    def __init__(self, plan: str, start_date: date):
        self.plan = plan
        self.start_date = start_date
        
    @classmethod
    def annual(cls) -> "Subscription":
        today = date.today()
        return cls(plan="annual", start_date=today.replace(year=today.year - 1))
        
    @classmethod
    def trial(cls) -> "Subscription":
        return cls(plan="trial", start_date=date.today())
```

### Pattern 7: Custom Exception Hierarchy & Chaining
Catch specific errors, wrap generic ones with context. Preserve tracebacks with `from e`.
```python
class AppError(Exception): pass  # Base
class AuthError(AppError): pass
class PaymentError(AppError): pass

def charge(card: Card, amount: Decimal) -> Receipt:
    try:
        return gateway.process(card, amount)
    except GatewayTimeout as e:
        raise PaymentError(f"Retry failed for ${amount}") from e  # Preserves traceback chain
```

### Pattern 8: Structured Logging & Error Context
Wrap exceptions with rich context instead of string formatting. Log structured data.
```python
import logging
logger = logging.getLogger(__name__)

def fetch_remote(url: str) -> bytes:
    try:
        response = httpx.get(url)
        response.raise_for_status()
        return response.content
    except httpx.HTTPStatusError as exc:
        logger.error("HTTP %d for %s", exc.response.status_code, url)
        raise FetchError(f"Failed fetching {url}") from exc
    except Exception as exc:
        raise NetworkError(f"Failed connecting to {url}") from exc
```

### Pattern 9: Async/Await Best Practices
Keep async IO separate from CPU-bound work. Never block the event loop.
```python
# BAD: Blocking call in async
async def process():
    time.sleep(5)  # Blocks ALL concurrency!

# GOOD: Offload to thread/process pool
async def process():
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, cpu_heavy_task)

# Or better: use native async libraries (httpx, sqlalchemy.ext.asyncio)
```

### Pattern 10: TypedDict for Flexible Records
When you need dict-like behavior but with strict type safety for external interfaces.
```python
from typing import TypedDict, NotRequired

class Metadata(TypedDict):
    author: str          # Required by default
    tags: list[str]      # Optional
    created_at: str | None

def render(template: str, meta: Metadata) -> str: ...
```

---
## ANTI-PATTERNS TO AVOID
### 1. Mutable Default Arguments
```python
# BAD: Shared across calls
def add_item(item, basket=[]):
    basket.append(item)
    return basket

# GOOD: Immutable default
def add_item(item, basket: list[str] | None = None):
    if basket is None: basket = []
    basket.append(item)
    return basket
```

### 2. Bare `except:`
```python
# BAD: Swallows KeyboardInterrupt, SystemExit, etc.
try: run_heavy_task()
except: log("failed")  # DANGEROUS

# GOOD: Specific catches
try: run_heavy_task()
except TimeoutError: log("timeout")
except FileNotFoundError: log("missing file")
```

### 3. Overusing Classes for State
```python
# BAD: Class just to hold data
class ConfigLoader:
    def __init__(self): self.config = {}
    def load(self, path): self.config = yaml.load(path)
    def get(self, key): return self.config.get(key)

# GOOD: Simple function + dataclass/frozendict
def load_config(path: Path) -> Config: ...
cfg = load_config(Path("config.yaml"))
value = cfg.timeout  # Direct access
```

### 4. `any` or `object` as Type Hints
```python
# BAD: Defeats static checking
def parse(data: any) -> object: ...

# GOOD: Parametric types or generics
from typing import TypeVar
T = TypeVar("T")
def parse(data: dict[str, T]) -> T: ...
```

### 5. Monkeypatching for Testing
```python
# BAD: Alters global state
import original_module
original_module.func = mock_func  # Breaks parallel tests

# GOOD: Dependency injection or unittest.mock.patch() in fixtures
@pytest.fixture
def service_with_mocked_dep():
    dep = Mock(spec=Dependency)
    return Service(dep=dep)  # Isolated, clean
```

---
## LOOKUP COMMANDS
### Find Typing Patterns in Stdlib
```bash
# How does collections.abc work?
python3 -c "import inspect; from collections.abc import Mapping; print(inspect.getsource(Mapping))"
# How does typing.TypeVar constrain bounds?
Read https://docs.python.org/3/library/typing.html#typing.TypeVar
# How does contextlib suppress exceptions?
python3 -c "import contextlib; help(contextlib.suppress)"
```
### Find Pydantic Patterns
```bash
# Model validators & computed fields
Read https://docs.pydantic.dev/latest/concepts/validators/
# Generic models
Read https://docs.pydantic.dev/latest/concepts/generics/
# Performance tips
Read https://docs.pydantic.dev/latest/concepts/performance/
```
### Find Pathlib Patterns
```bash
# Globbing & iteration
python3 -c "from pathlib import Path; help(Path.glob)"
# Pure vs PurePosixPath vs WindowsPath
python3 -c "from pathlib import PurePath; print(PurePath.__subclasses__())"
```

---
## WHEN TO APPLY THESE PATTERNS
| Situation | Pattern to Use |
|-----------|----------------|
| API Payloads / Configs | Pydantic `BaseModel` |
| Capabilities (can X?) | `Protocol` (structural subtyping) |
| File/Dir paths | `pathlib.Path` |
| Multiple implementations | Strategy pattern + `Protocols` |
| Wrapper for ID/Email/Amount | `NewType` / distinct class |
| Complex `if/elif` logic | `match/case` |
| Setup/Teardown needed | `@contextmanager` or `with` |
| DTO without logic | `@dataclass(frozen=True)` |
| Validation at entry point | Smart Constructor / `model_validate` |
| Resource acquisition | `with open(...) as f:` |

---
## WORKFLOW
1. **Before defining classes**: Ask "Can this be a function + dataclass?"
2. **Before accepting dict**: Ask "Should this be a Pydantic model for validation?"
3. **Before string comparison**: Ask "Could this be an Enum or Literal?"
4. **Before `os.path`**: Ask "Am I using pathlib operations?"
5. **Before catching all errors**: Ask "Am I only catching what I can actually recover from?"
**Always prefer explicit interfaces and runtime checks at the system boundary.**

---
## ADVANCED PATTERNS FROM STDLIB & COMMUNITY
### Pattern 11: Memory-Efficient Objects with `__slots__`
```python
# Bad: Dict per instance (~256 bytes overhead)
class Point: def __init__(self, x, y): self.x = x; self.y = y

# Good: Tuple-like memory layout
@dataclass(slots=True, frozen=True)
class Point: x: float; y: float

# Saves ~40% memory in tight loops / large datasets
```

### Pattern 12: Dependency Injection via Functions/Defaults
Avoid heavy DI containers. Pass dependencies explicitly or use lazy defaults.
```python
# BAD: Global singleton
def do_work():
    db = get_global_db()  # Hard to test, hidden coupling

# GOOD: Explicit parameters (or factory closures)
def do_work(db: Database | None = None):
    if db is None: db = get_prod_db()
    # ...
```

---
## WHEN TO USE WHAT (Quick Reference)
| You Need | Use This | Not This |
|----------|----------|----------|
| Input validation | Pydantic `Dataclass`/`BaseModel` | Manual `if`s |
| Interface contract | `Protocol` | Abstract Base Class (`ABC`) |
| File paths | `pathlib.Path` | `os.path` strings |
| Unique identifiers | `NewType` / `str` subclass | Plain `int` / `str` |
| Configuration | `pydantic-settings.Settings` | `os.environ.get()` |
| State transitions | `match/case` + immutable models | Mutable flags / state vars |
| External deps | Inject via `__init__` or kwargs | Global imports / singletons |
| Parallel processing | `concurrent.futures` or `multiprocessing` | Threading (GIL limits CPU) |

---
## FINAL WORKFLOW
**Before writing any Python code:**
1. **Is this a data container?** → `@dataclass` or `NamedTuple`
2. **Is this an API request/response?** → Pydantic `BaseModel`
3. **Do I need capabilities/interfaces?** → `Protocol` (structural subtyping)
4. **Is this a filesystem operation?** → `pathlib`
5. **Is this a long-lived resource?** → `contextlib.contextmanager`
6. **Am I doing complex branching?** → `match/case`
7. **Are there shared defaults?** → `None` sentinel pattern or `@classmethod`
**Always check `ruff` and `mypy` output before committing. Let tools enforce style.**