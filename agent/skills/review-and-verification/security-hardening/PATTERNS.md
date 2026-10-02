# Vulnerability Patterns by Language

Each pattern includes: CWE, **executable grep regex**, code example, and fix.
Use the regex in `Search:` fields directly with grep/ripgrep. Patterns are case-sensitive unless noted.

---

## Universal (All Languages)

### Hardcoded Secrets (CWE-798)

**Search (case-insensitive):**
```regex
[Pp]assword\s*=\s*["'][^"']+["']
[Aa]pi[_-]?[Kk]ey\s*=\s*["'][^"']+["']
[Ss]ecret\s*=\s*["'][^"']+["']
[Tt]oken\s*=\s*["'][^"']+["']
AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY
-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----
AKIA[0-9A-Z]{16}
(DB_|DATABASE_)PASSWORD\s*=\s*["'][^"']+["']
```

**Fix:** Use environment variables or secret managers. Never commit credentials.

### Insecure Randomness (CWE-330)

**Search:**
```regex
Math\.random\(\)
random\.random\(\)
random\.randint\(
\brand\(\)
\bRandom\(\)
java\.util\.Random
```

**Fix:** Use cryptographic RNG (`crypto.randomBytes`, `secrets`, `crypto/rand`, `SecureRandom`).

---

## JavaScript / TypeScript

### SQL Injection (CWE-89)

**Search:**
```regex
query\s*\(\s*`[^`]*\$\{
query\s*\([^)]*\+\s*\w
\.raw\s*\(\s*`[^`]*\$\{
execute\s*\(\s*`[^`]*\$\{
(query|sql|stmt)\s*=\s*`[^`]*\$\{
SELECT\s.*\$\{
SELECT\s.*\+\s*\w
```

**Example:** `query(\`SELECT * FROM users WHERE id = ${userId}\`)`
**Fix:** Parameterized queries: `query('SELECT * FROM users WHERE id = ?', [userId])`

### XSS (CWE-79)

**Search:**
```regex
\.innerHTML\s*=
dangerouslySetInnerHTML
document\.write\s*\(
\.outerHTML\s*=
\$\(\s*['"].*['"].*\)\.html\s*\(
```

**Example:** `element.innerHTML = userInput`
**Fix:** Use `textContent`, sanitize with DOMPurify, or framework auto-escaping.

### Prototype Pollution (CWE-1321)

**Search:**
```regex
Object\.assign\s*\([^,]+,\s*(req\.|params|body|query|input)
_\.merge\s*\([^,]+,\s*(req\.|params|body|query|input)
\[.*\]\s*=.*\b(req|params|body|query|input)\b
```

**Example:** `Object.assign(settings, req.body)`
**Fix:** Validate keys against `__proto__`, `constructor`, `prototype`. Use `Object.create(null)`.

### Path Traversal (CWE-22)

**Search:**
```regex
path\.join\s*\([^)]*req\.
res\.sendFile\s*\(
fs\.(readFile|writeFile|createReadStream)\s*\([^)]*req\.
```

**Example:** `res.sendFile(req.params.filename)`
**Fix:** `path.resolve()` then verify result starts with intended base directory.

### SSRF (CWE-918)

**Search:**
```regex
(fetch|axios\.(get|post|put)|http\.get|got|request)\s*\(\s*(req\.|params|body|query|input|url|user)
```

**Example:** `axios.get(req.body.url)`
**Fix:** Allowlist domains, block private IPs (127.0.0.0/8, 10.0.0.0/8, 169.254.169.254).

### Command Injection (CWE-78)

**Search:**
```regex
\bexec\s*\(\s*`[^`]*\$\{
\bexec\s*\([^)]*\+\s*\w
child_process\.(exec|execSync)\s*\(
\bspawn\s*\(\s*['"]sh['"]
```

**Example:** `` exec(`git clone ${url}`) ``
**Fix:** Use `execFile` with argument arrays, never shell interpolation.

### Insecure Deserialization (CWE-502)

**Search:**
```regex
serialize\.unserialize\s*\(
yaml\.load\s*\([^)]*\)(?!.*safe)
node-serialize
js-yaml.*load\(
```

**Example:** `serialize.unserialize(req.body.payload)` — RCE
**Fix:** Never deserialize untrusted data. Use `yaml.safeLoad`.

---

## Python

### SQL Injection (CWE-89)

**Search:**
```regex
\.execute\s*\(\s*f["']
\.execute\s*\([^)]*%\s*\(?\w
\.execute\s*\([^)]*\.format\s*\(
\.execute\s*\([^)]*\+\s*\w
(query|sql|stmt)\s*=\s*f["']SELECT
f["']SELECT\s
```

**Example:** `cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")`
**Fix:** `cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))`

### Command Injection (CWE-78)

**Search:**
```regex
os\.system\s*\(
os\.popen\s*\(
subprocess\.(call|run|Popen)\s*\([^)]*shell\s*=\s*True
\beval\s*\(\s*(req|request|input|user|data)
\bexec\s*\(\s*(req|request|input|user|data)
```

**Example:** `os.system(f"ping {host}")`
**Fix:** `subprocess.run(["ping", host], shell=False)` with input validation.

### Deserialization (CWE-502)

**Search:**
```regex
pickle\.(loads?|Unpickler)\s*\(
yaml\.load\s*\([^)]*\)(?!.*Loader)
yaml\.load\s*\([^)]*\)(?!.*safe)
marshal\.loads?\s*\(
shelve\.open\s*\(
```

**Example:** `pickle.loads(untrusted_data)` — arbitrary code execution
**Fix:** Never unpickle untrusted data. Use `yaml.safe_load`.

### Path Traversal (CWE-22)

**Search:**
```regex
open\s*\(\s*os\.path\.join\s*\([^)]*\b(req|request|input|user|filename)\b
open\s*\(\s*(req|request|input|user|filename)
pathlib\.Path\s*\([^)]*\)\s*/\s*(req|request|input|user)
send_file\s*\([^)]*req
```

**Example:** `open(os.path.join(base_dir, user_filename))`
**Fix:** Resolve path, then check `resolved.is_relative_to(base_dir)` (Python 3.9+).

### SSTI (CWE-1336)

**Search:**
```regex
render_template_string\s*\(\s*(req|request|input|user|\w*name|f['"])
Template\s*\(\s*(req|request|input|user)
Jinja2.*from_string\s*\(
```

**Example:** `render_template_string(user_input)`
**Fix:** Never pass user input as template source. Use template variables only.

---

## Go

### SQL Injection (CWE-89)

**Search:**
```regex
\.(Query|Exec|QueryRow)\s*\(\s*["'][^"']*["']\s*\+
\.(Query|Exec|QueryRow)\s*\(\s*fmt\.Sprintf
```

**Example:** `db.Query("SELECT * FROM users WHERE id = " + userId)`
**Fix:** `db.Query("SELECT * FROM users WHERE id = ?", userId)`

### Path Traversal (CWE-22)

**Search:**
```regex
filepath\.Join\s*\([^)]*r\.(URL|Form|PostForm)
os\.(Open|ReadFile|Create)\s*\([^)]*r\.(URL|Form|PostForm)
http\.ServeFile\s*\([^)]*r\.
```

**Example:** `http.ServeFile(w, r, filepath.Join(baseDir, r.URL.Path))`
**Fix:** `filepath.Clean()` then verify `strings.HasPrefix(cleaned, baseDir)`.

### SSRF (CWE-918)

**Search:**
```regex
http\.(Get|Post|Head)\s*\(\s*\w*(url|uri|URL|URI|endpoint|target)
http\.NewRequest\s*\([^)]*\w*(url|uri|input|user)
```

**Example:** `http.Get(userProvidedURL)`
**Fix:** Parse URL, validate against allowlist, block private ranges.

### Race Conditions (CWE-362)

**Search:**
```regex
go\s+func\s*\(\s*\)\s*\{[^}]*(counter|total|count|sum|balance)\s*(\+\+|--|[\+\-\*]=)
```

**Example:** `go func() { counter++ }()`
**Fix:** Use `sync.Mutex`, `sync/atomic`, or channels.

---

## Rust

### Unsafe Blocks (CWE-119, CWE-416)

**Search:**
```regex
\bunsafe\s*\{
std::mem::transmute
slice::from_raw_parts
std::ptr::(read|write|copy)
```

**Example:** `unsafe { *raw_ptr }`
**Verify:** Pointer validity, lifetime guarantees, alignment, no aliasing violations.

### SQL Injection (CWE-89)

**Search:**
```regex
sqlx::query\s*\(\s*&format!\s*\(
query\s*\(\s*&format!\s*\(
execute\s*\(\s*&format!\s*\(
```

**Example:** `sqlx::query(&format!("SELECT * FROM users WHERE id = {}", id))`
**Fix:** `sqlx::query("SELECT * FROM users WHERE id = $1").bind(id)`

### Command Injection (CWE-78)

**Search:**
```regex
Command::new\s*\(\s*["']sh["']\)
Command::new\s*\(\s*["']bash["']\)
Command::new\s*\(\s*["']cmd["']\)
\.arg\s*\(\s*["']-c["']\s*\)
Command::new\s*\(\s*\w*(input|user|cmd)
```

**Example:** `Command::new("sh").arg("-c").arg(user_input).output()`
**Fix:** `Command::new("program").args(&[validated_arg])` — no shell.

---

## C / C++

### Buffer Overflow (CWE-120)

**Search:**
```regex
\bstrcpy\s*\(
\bsprintf\s*\(
\bgets\s*\(
\bstrcat\s*\(
\bscanf\s*\(\s*["'][^"']*%s
```

**Example:** `strcpy(dest, src);`
**Fix:** `strncpy`, `snprintf`, `fgets` with explicit size limits.

### Use After Free (CWE-416)

**Search:**
```regex
\bfree\s*\(\s*(\w+)\s*\)
\bdelete\s+\w+\s*;
```

**Note:** Requires control-flow analysis. Flag `free()` calls and verify the pointer is not used afterward.
**Fix:** Set pointer to NULL after free. Use RAII/smart pointers in C++.

### Integer Overflow (CWE-190)

**Search:**
```regex
malloc\s*\(\s*\w+\s*\*\s*\w+
calloc\s*\(\s*\w+\s*,\s*\w+\s*\*
realloc\s*\(\s*[^)]*\*
\w+\s*\*\s*sizeof\s*\(
```

**Example:** `malloc(count * sizeof(element));`
**Fix:** Check for overflow before arithmetic: `if (count > SIZE_MAX / sizeof(element))`.

### Format String (CWE-134)

**Search:**
```regex
printf\s*\(\s*\w+\s*\)(?!\s*,)
fprintf\s*\(\s*\w+\s*,\s*\w+\s*\)(?!\s*,)
syslog\s*\(\s*\w+\s*,\s*\w+\s*\)(?!\s*,)
snprintf\s*\([^,]+,[^,]+,\s*\w+\s*\)(?!\s*,)
```

**Example:** `printf(user_input);`
**Fix:** `printf("%s", user_input);` — always use format specifier.

---

## Java

### SQL Injection (CWE-89)

**Search:**
```regex
(executeQuery|executeUpdate|execute)\s*\(\s*["'][^"']*["']\s*\+
(createStatement|prepareCall)\s*\(\s*\)\s*;[^;]*\+
Statement\s+\w+\s*=.*createStatement
```

**Example:** `stmt.executeQuery("SELECT * FROM users WHERE id = " + userId);`
**Fix:** `PreparedStatement` with `?` placeholders.

### Deserialization (CWE-502)

**Search:**
```regex
ObjectInputStream
\.readObject\s*\(
XMLDecoder
XStream.*fromXML
```

**Example:** `new ObjectInputStream(untrustedStream).readObject()`
**Fix:** Use allowlist-based `ObjectInputFilter` (Java 9+), or avoid native serialization entirely.

### XXE (CWE-611)

**Search:**
```regex
DocumentBuilderFactory\.newInstance
SAXParserFactory\.newInstance
XMLInputFactory\.newInstance
TransformerFactory\.newInstance
```

**Note:** Flag XML parser instantiation, then verify external entity processing is disabled.
**Fix:** Disable DTDs and external entities on all XML parsers.

### SSRF (CWE-918)

**Search:**
```regex
new\s+URL\s*\(\s*\w*(input|user|param|request|url|uri)
HttpURLConnection.*openConnection
HttpClient.*send\s*\([^)]*\w*(input|user|url)
```

**Example:** `new URL(userInput).openConnection()`
**Fix:** Validate URL against allowlist, block private IP ranges.

---

## Configuration Vulnerabilities

### CORS Misconfiguration

**Search:**
```regex
Access-Control-Allow-Origin:\s*\*
cors\(\s*\{[^}]*origin:\s*['"]?\*
Access-Control-Allow-Credentials:\s*true
```

### Missing Security Headers

**Search (check for ABSENCE of):**
```regex
Strict-Transport-Security
Content-Security-Policy
X-Content-Type-Options
X-Frame-Options
Referrer-Policy
Permissions-Policy
```

### Debug/Dev Mode in Production

**Search:**
```regex
DEBUG\s*=\s*True
NODE_ENV\s*=\s*['"]?development
app\.debug\s*=\s*True
FLASK_DEBUG\s*=\s*1
spring\.profiles\.active.*dev
```

### Permissive File Permissions

**Search:**
```regex
chmod\s+7[67][67]
chmod\s+666
os\.chmod\s*\([^)]*0o?7[67][67]
```
