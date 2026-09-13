---
name: frontend-design
description: "Complete frontend design & implementation pipeline. Covers UI/UX principles, component architecture, accessibility (WCAG 2.1 AA), responsive layouts, design tokens, performance optimization (Core Web Vitals), and browser-verified visual correctness. Triggers: 'ui', 'ux', 'design', 'component', 'layout', 'responsive', 'accessibility', 'a11y', 'aria', 'CSS', 'flexbox', 'grid', 'tokens', 'design system', 'performance', 'Core Web Vitals', 'visual testing', 'browser automation', 'screenshot', 'computed styles', 'pixel-perfect', 'Figma', 'implementation'."
---

# Frontend Design & Browser-Verified Implementation Pipeline

**Philosophy**: Semantic HTML first → Composable components → Token-driven consistency → Browser-verified accuracy. Structure over pixels; verification over hope.
**References**: [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web) · [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/) · [Tailwind CSS](https://tailwindcss.com/docs) · [web.dev Vitals](https://web.dev/vitals/) · [ECMAScript Spec](https://tc39.es/ecma262/)

**ECMAScript Version Policy**: Match the repository's existing ES target (check `tsconfig.json` `target`/`lib`, `browserslist`, `.babelrc` presets, or `package.json` `engines`). If unspecified, use the latest ECMAScript edition. Specs by year: `https://tc39.es/ecma262/{YEAR}/` (e.g., `https://tc39.es/ecma262/2025/`).

---

## CORE PRINCIPLES

### 1. Semantic HTML First

Native elements carry built-in semantics, keyboard navigation, and screen reader support. Only reach for `<div>` or ARIA when native elements can't express what you need.

```html
<!-- BAD -->
<div class="btn-primary" onclick="submit()">Submit</div>
<div class="input-wrapper">
  <span>Name</span>
  <div class="field"></div>
</div>

<!-- GOOD -->
<button type="submit" class="btn-primary">Submit</button>
<label for="name-input">Name</label>
<input id="name-input" type="text" required />
```

**Rules:**

- Landmarks: `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`
- `<button>` for actions, `<a>` for navigation
- Heading hierarchy sequential (`<h1>` → `<h6>`, never skip)
- Tables: `<thead>`, `<tbody>`, `<th scope="col/row">`, `<caption>`
- Forms: `<fieldset>`, `<legend>`, explicit `<label for="id">`

### 2. Mobile-First Responsive Design

Design for smallest viewport first, progressively enhance.

```css
/* Mobile base (no media query) */
.container {
  width: 100%;
  padding: 0 1rem;
}
.card-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

@media (min-width: 640px) {
  .container {
    max-width: 640px;
    margin: 0 auto;
  }
  .card-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (min-width: 1024px) {
  .container {
    max-width: 1024px;
  }
  .card-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
```

**Rules:**

- `min-width` breakpoints, not `max-width`
- Breakpoints: 640px (sm), 768px (md), 1024px (lg), 1280px (xl)
- Touch targets: minimum 44×44px (Apple HIG) or 48×48dp (Material)

### 3. Accessibility (WCAG 2.1 AA Minimum)

Not an afterthought — baked into every component.

```html
<img src="chart.png" alt="Sales chart showing Q4 revenue increased 23% from Q3" />
<button aria-label="Close dialog">✕</button>
<div aria-live="polite" aria-relevant="additions removals"><p id="notif-msg"></p></div>
<div role="alert" id="error-summary" aria-describedby="error-details">
  <ul id="error-details">
    <li>Error message here</li>
  </ul>
</div>
```

**ARIA Principles:**

1. If a native element works, use it
2. All interactive custom widgets need keyboard support
3. Live content needs `aria-live` regions
4. Forms need visible labels or `aria-label`/`aria-labelledby`
5. Focus must be visible and manageable

### 4. Design Tokens Drive Consistency

Tokens replace magic values and enable theming. Validate them in the browser to catch drift.

```css
/* Primitive tokens */
:root {
  --color-primary-500: #3b82f6;
  --color-primary-700: #1d4ed8;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --radius-md: 0.5rem;
  --font-sans: 'Inter', system-ui, sans-serif;
}
/* Semantic tokens */
:root {
  --bg-surface: var(--color-white);
  --text-primary: var(--color-gray-900);
  --spacing-section: var(--space-8);
  --transition-fast: 150ms ease;
}
/* Usage */
.card {
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  padding: var(--spacing-component);
}
```

### 5. Dual-Mode Verification: Structure + Vision

Combine accessibility snapshots (semantics, labels, focus order) with screenshots (layout, spacing, colors). Never rely on only one. Snapshots catch structural bugs; screenshots catch visual regressions.

```
# BAD: Only structure — "Verify the sidebar has a heading and nav links."
# BAD: Only visuals — "Screenshot the page. Does the button look right?"

# GOOD: Both —
# "Navigate to /dashboard. Snapshot to verify role='navigation' contains 'Settings'.
#  Screenshot the header to verify padding/alignment match Figma.
#  Evaluate computed styles on the primary CTA to confirm --color-primary value."
```

### 6. Computed Style Inspection Over Guesswork

CSS renders differently than it reads. Always evaluate computed styles in the browser to verify specs.

```javascript
// The JS you need to run in the browser (via whatever tool you have):
const el = document.querySelector('[data-testid="card"]');
const s = getComputedStyle(el);
({
  width: s.width,
  height: s.height,
  padding: s.padding,
  backgroundColor: s.backgroundColor,
  borderRadius: s.borderRadius,
  fontFamily: s.fontFamily,
});
```

---

## LAYOUT PATTERNS

### Flexbox vs Grid

| Use Case                                | Flexbox    | CSS Grid   |
| --------------------------------------- | ---------- | ---------- |
| Single-axis alignment                   | ✅         | ❌         |
| Content-driven sizing                   | ✅         | Partial    |
| Two-dimensional layout                  | ❌         | ✅         |
| Equal-height columns                    | Extra work | ✅ Auto    |
| Page shell (header/sidebar/main/footer) | ❌ Poor    | ✅ Perfect |

```css
/* Flexbox: nav bar */
.nav-items {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

/* Grid: page shell */
.page-layout {
  display: grid;
  grid-template-columns: 250px 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas: 'header header' 'sidebar main' 'footer footer';
}

/* Grid: responsive gallery */
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 1rem;
}
```

### How to Verify Layout in the Browser

Evaluate these computed properties on your layout containers to confirm the browser is rendering what you wrote:

```javascript
// Flexbox verification
const s = getComputedStyle(document.querySelector('.nav-items'));
({ display: s.display, flexDirection: s.flexDirection, justifyContent: s.justifyContent, gap: s.gap });

// Grid verification
const g = getComputedStyle(document.querySelector('.gallery'));
({ display: g.display, gridTemplateColumns: g.gridTemplateColumns, gap: g.gap });
```

---

## COMPONENT ARCHITECTURE PATTERNS

### Container/Presentational Split

Separate data-fetching from rendering.

```tsx
// Presentational — props in, JSX out, no side effects
function UserList({ users, emptyMessage, isLoading }) {
  if (isLoading) return <LoadingSpinner />;
  if (!users?.length) return <p>{emptyMessage || 'No users found'}</p>;
  return (
    <ul className='user-list'>
      {users.map((u) => (
        <UserCard key={u.id} user={u} />
      ))}
    </ul>
  );
}
// Container — fetches, manages state
function UserListContainer() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then(setUsers);
  }, []);
  return <UserList users={users} />;
}
```

### Compound Components

Parent-child share context implicitly. Best for related interactive groups.

```tsx
const TabsContext = createContext(null);
function Tabs({ defaultValue, children }) {
  const [activeTab, setActiveTab] = useState(defaultValue);
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div role='tablist'>{children}</div>
    </TabsContext.Provider>
  );
}
```

### Custom Hooks for Reusable Logic

```tsx
function useLocalStorage(key, initialValue) {
  const [val, setVal] = useState(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });
  return [
    val,
    (v) => {
      const next = v instanceof Function ? v(val) : v;
      setVal(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
  ];
}

function useDebounce(value, delay = 300) {
  const [d, setD] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setD(value), delay);
    return () => clearTimeout(h);
  }, [value, delay]);
  return d;
}
```

### Error Boundaries (React)

```tsx
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.hasError)
      return (
        <div className='error-boundary'>
          <h2>Something went wrong</h2>
          <button onClick={() => this.setState({ hasError: false })}>Try Again</button>
        </div>
      );
    return this.props.children;
  }
}
```

---

## ACCESSIBILITY PATTERN REFERENCE

### Landmark Structure

```html
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <header role="banner"><nav aria-label="Primary">...</nav></header>
  <main id="main-content" role="main">
    <section aria-labelledby="hero-heading"><h1 id="hero-heading">Welcome</h1></section>
  </main>
  <footer role="contentinfo">...</footer>
</body>
```

### Widget Patterns (APG Reference)

**Dialog:**

```html
<button id="open-dialog" aria-haspopup="dialog">Open Settings</button>
<div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
  <h2 id="dialog-title">Settings</h2>
  <button aria-label="Close dialog">✕</button>
</div>
```

**Accordion:**

```html
<button aria-expanded="false" aria-controls="panel-1">Section 1 ▾</button>
<div id="panel-1" role="region" hidden>Content 1</div>
```

**Tabs:**

```html
<div role="tablist" aria-label="Project Info">
  <button role="tab" aria-selected="true" aria-controls="panel-about" id="tab-about">About</button>
  <button role="tab" aria-selected="false" aria-controls="panel-team" id="tab-team">Team</button>
</div>
<div role="tabpanel" id="panel-about" aria-labelledby="tab-about">About content</div>
<div role="tabpanel" id="panel-team" aria-labelledby="tab-team" hidden>Team content</div>
```

---

## BROWSER VERIFICATION METHODOLOGY

These patterns describe **what to verify and why**. Use whatever browser tool is available (Playwright MCP, agent-browser, built-in browser tools, DevTools, etc.) to execute these operations:

- **Navigate** → load a URL
- **Snapshot** → get the accessibility tree / DOM structure
- **Screenshot** → capture visual state as an image
- **Evaluate** → run JavaScript in the page context to extract computed styles
- **Resize** → change viewport dimensions
- **Interact** → click, hover, focus, type, press keys

### The Design-to-Browser Pipeline

Standard workflow when implementing or reviewing a UI spec:

```
1. Navigate to dev URL / staging
2. Snapshot → verify DOM structure & ARIA roles match the wireframe
3. Screenshot → capture visual state for comparison
4. Evaluate getComputedStyle → measure padding, gap, font-size, colors
5. Compare outputs against design spec / Figma measurements
6. Patch CSS → repeat steps 2–5 until verified
```

### Responsive Breakpoint Validation

Test critical breakpoints systematically:

```
For each breakpoint (375px, 768px, 1024px, 1440px):
  1. Resize viewport
  2. Snapshot → verify layout changes (column count, nav collapse, etc.)
  3. Screenshot → capture visual state at this width
  4. Evaluate → measure actual column count, element widths, gap sizes
```

**What to check per breakpoint:**

- Grid column count changes correctly
- Navigation collapses to hamburger at mobile
- Touch targets remain ≥ 44px on small viewports
- No horizontal overflow / scrollbar appears
- Font sizes remain readable (≥ 16px body on mobile)

### UI State Verification

Every interactive component has multiple states. Verify each:

| State              | What to check                             | How                                       |
| ------------------ | ----------------------------------------- | ----------------------------------------- |
| **Default**        | Correct styling, tokens applied           | Screenshot + evaluate computed styles     |
| **Empty**          | Empty state message, no broken layout     | Navigate with empty data, snapshot        |
| **Loading**        | Skeleton/spinner visible, no layout shift | Screenshot during load                    |
| **Error**          | Error message accessible, `role="alert"`  | Snapshot for ARIA, screenshot for styling |
| **Hover**          | Visual feedback, cursor change            | Hover element → screenshot                |
| **Focus**          | Visible focus ring, correct outline       | Tab to element → evaluate outline styles  |
| **Active/Pressed** | Visual depression/feedback                | Click → screenshot                        |
| **Disabled**       | Dimmed, `aria-disabled`, not clickable    | Snapshot for attributes, evaluate opacity |

### Screenshot Naming Convention

Name screenshots descriptively so they serve as documentation:

```
{route}-{breakpoint}-{state}.png
Examples:
  home-mobile-default.png
  dashboard-tablet-authenticated.png
  settings-desktop-dark.png
  modal-mobile-error.png
```

### Token & Style Validation

Run this JS in the browser to extract and validate design tokens at runtime:

```javascript
// Extract all CSS custom properties from :root
const rootStyles = getComputedStyle(document.documentElement);
const tokenNames = ['--color-primary-500', '--space-4', '--radius-md', '--font-sans'];
const actual = Object.fromEntries(tokenNames.map((t) => [t, rootStyles.getPropertyValue(t).trim()]));
// Compare `actual` against your design spec values
```

```javascript
// Contrast ratio calculation
function contrastRatio(fg, bg) {
  function luminance(rgb) {
    return rgb
      .match(/\d+/g)
      .map(Number)
      .map((c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  }
  const l1 = luminance(fg),
    l2 = luminance(bg);
  return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2);
}
// Usage: contrastRatio(getComputedStyle(el).color, getComputedStyle(el.parentElement).backgroundColor)
// WCAG AA requires ≥ 4.5:1 for normal text, ≥ 3:1 for large text
```

### Dark Mode / Theme Verification

After toggling theme:

1. **Evaluate** background and text colors → confirm they swapped correctly
2. **Screenshot** → visual confirmation of theme application
3. **Check contrast** → dark themes often fail WCAG AA on muted text
4. **Verify transitions** → theme switch should not cause layout shift

### Focus & Keyboard Navigation Audit

```
1. Tab through the page → verify focus order matches visual order
2. At each focused element, evaluate:
   - outlineColor, outlineStyle, outlineWidth (must be visible, never `outline: none` without replacement)
   - boxShadow (some designs use shadow instead of outline — acceptable if visible)
3. Verify focus traps on modals (Tab cycles within dialog, Escape closes)
4. Verify skip links work (first Tab stop → "Skip to main content")
```

### Animation & Transition Audit

Evaluate these properties on animated elements:

```javascript
const s = getComputedStyle(element);
({
  transitionDuration: s.transitionDuration,
  transitionProperty: s.transitionProperty,
  animationDuration: s.animationDuration,
  willChange: s.willChange,
});
```

**Rules:**

- Duration ≤ 300ms for micro-interactions
- Only animate `transform` and `opacity` for GPU compositing (avoid animating `width`, `height`, `top`, `left`)
- `prefers-reduced-motion: reduce` must disable or simplify animations

### Performance Measurement

Run in the browser to check Core Web Vitals:

```javascript
const paint = performance.getEntriesByType('paint');
({
  firstPaint: paint.find((e) => e.name === 'first-paint')?.startTime,
  firstContentfulPaint: paint.find((e) => e.name === 'first-contentful-paint')?.startTime,
});
```

---

## PERFORMANCE PATTERNS

### Core Web Vitals Targets

| Metric                              | Good    | Needs Improvement | Poor    |
| ----------------------------------- | ------- | ----------------- | ------- |
| **LCP** (Largest Contentful Paint)  | ≤ 2.5s  | ≤ 4.0s            | > 4.0s  |
| **INP** (Interaction to Next Paint) | ≤ 200ms | ≤ 500ms           | > 500ms |
| **CLS** (Cumulative Layout Shift)   | ≤ 0.1   | ≤ 0.25            | > 0.25  |
| **TTFB** (Time to First Byte)       | ≤ 800ms | ≤ 1.8s            | > 1.8s  |
| **FCP** (First Contentful Paint)    | ≤ 1.8s  | ≤ 3.0s            | > 3.0s  |

### Optimization Checklist

```jsx
// Code splitting
const LazyComponent = lazy(() => import('./HeavyComponent'));
<Suspense fallback={<LoadingSkeleton />}><LazyComponent /></Suspense>

// Image optimization
<img src="image.webp" srcSet="image-320.webp 320w, image-768.webp 768w"
     sizes="(max-width: 640px) 100vw, 50vw" loading="lazy" decoding="async" alt="Description"/>

// Prevent layout shift
.container { aspect-ratio: 16 / 9; min-height: 400px; }

// Prefetch critical resources
<link rel="preload" href="/critical-font.woff2" as="font" crossorigin>
<link rel="prefetch" href="/next-page.js">
```

---

## ANTI-PATTERNS

### 1. Div Soup

```html
<!-- BAD -->
<div class="wrapper outer inner flex column gap-2">
  <div class="card rounded shadow p-4"><div class="title bold text-xl">Title</div></div>
</div>
<!-- GOOD -->
<article class="card featured">
  <header class="card__header"><h3>Featured Article</h3></header>
  <p>Content.</p>
</article>
```

### 2. Pixel-Perfect Without Semantic Validation

```
# BAD: "The logo should be exactly 142x32px. Measure it."
# GOOD: "Verify logo maintains aspect ratio across viewports. Check it's in <a> with proper aria-label."
```

### 3. Eyeballing Colors Instead of Computing Them

```
# BAD: "The button looks slightly purple instead of blue."
# GOOD: "Evaluate the computed backgroundColor of the CTA button. Return the hex value."
```

### 4. CSS Changes Without Checking Siblings

A margin tweak on a card can break adjacent elements. After any spacing change:
→ Screenshot the modified element AND its neighbors

### 5. Ignoring prefers-reduced-motion

```css
/* BAD */
.spinner {
  animation: spin 1s linear infinite;
}
/* GOOD */
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
```

### 6. Color Contrast Failures

```css
/* BAD: ~2.1:1 ratio — FAILS AA */
.text-muted {
  color: #aaa;
}
/* GOOD: ~4.6:1 ratio — PASSES AA */
.text-muted {
  color: #6b7280;
}
```

### 7. Screenshots Without Baselines

Loose screenshots create false confidence. Always:

- Name with convention: `route-breakpoint-state.png`
- Compare before/after pairs when iterating
- Use visual diff tools in CI for automated regression

---

## WORKFLOW CHECKLIST

### Phase 1: Design → Implementation

**Before writing markup:**

1. "Is there a semantic HTML element for this purpose?"
2. Choose composition: children/slots, compound components, or render props
3. Define design tokens before writing CSS

**Before releasing UI changes:**

- [ ] Semantic HTML for every element
- [ ] All interactive elements keyboard-accessible
- [ ] Focus visible and navigable
- [ ] Color contrast ≥ 4.5:1 (body) / 3:1 (large text)
- [ ] Images have meaningful alt (or `alt=""` if decorative)
- [ ] No content reflow during interaction (CLS ≤ 0.1)
- [ ] LCP ≤ 2.5s
- [ ] `prefers-reduced-motion` respected
- [ ] Text readable at 200% zoom
- [ ] Form inputs have associated labels

### Phase 2: Browser Verification

**Before shipping any UI screen:**

1. **Navigate** to dev URL with fresh state
2. **Snapshot + Screenshot** → capture baseline
3. **Verify semantics** → role hierarchy, labels, tabindex, focus traps
4. **Inspect regions** → header, sidebar, cards, forms, empty states
5. **Evaluate critical CSS** → padding, gap, font-size, colors via `getComputedStyle`
6. **Test viewports** → 375px → 768px → 1280px → 1440px
7. **Test interactions** → hover, focus, click → capture each state
8. **Verify tokens** → custom properties match spec values
9. **Note deviations** → layout shifts, overflow, contrast failures
10. **Iterate** → fix CSS → repeat 2–9 → confirm fix + no regression

**For PR reviews:**

1. Load affected routes on the branch
2. Before/after screenshots for changed sections
3. Evaluate computed styles on modified elements
4. Check adjacent components for collateral damage
5. Verify contrast if colors/fonts changed

### Phase 3: Advanced

1. Content overflow: long strings, emoji, RTL
2. Print stylesheet (`emulateMediaType('print')`)
3. Animation timing ≤ 300ms, GPU-composited properties only
4. Focus ring visible (never bare `outline: none`)
5. `aria-live` on dynamic content updates

---

## QUICK REFERENCE

| You Need             | Do This                                  | Not This                     |
| -------------------- | ---------------------------------------- | ---------------------------- |
| Layout understanding | Snapshot + semantic inspection           | Screenshot alone             |
| Visual confirmation  | Screenshot + computed style values       | Memory/judgment              |
| Exact spacing/colors | Evaluate `getComputedStyle`              | Eyeballing Figma vs browser  |
| Multi-screen testing | Resize viewport + capture per breakpoint | Single device assumption     |
| State variations     | Named screenshots per state              | Verbal description           |
| Token drift          | Extract CSS variables in browser         | Hardcoded expected values    |
| Typography           | Evaluate font metrics                    | Guessing font-family         |
| Focus management     | Tab navigation + evaluate outline        | Assuming it works            |
| Animation quality    | Evaluate transition properties           | "Feels smooth"               |
| QA signoff           | Before/after screenshot pairs            | "Looks okay"                 |
| Component reuse      | Children/slots/compound                  | Deep prop drilling           |
| Data fetching        | React Query/SWR/TanStack                 | `useEffect` + raw fetch      |
| Theme switching      | CSS custom properties + media queries    | Inline conditional classes   |
| Large lists          | Virtualization / infinite scroll         | Rendering 1000s of DOM nodes |
| Complex forms        | Form library + schema validation         | Manual `useState` per field  |

---

## DECISION TREE

1. **Need structure?** → Snapshot + verify semantics
2. **Need visuals?** → Screenshot + evaluate computed styles
3. **Changing CSS?** → Capture before, change, capture after, compare
4. **Mobile broken?** → Resize to 375px → re-verify
5. **Colors/tokens correct?** → Evaluate computed values in browser
6. **Interaction correct?** → Hover/focus/click → capture each state
7. **Something shifted?** → Screenshot adjacent siblings immediately
8. **Architecture question?** → Compose from existing? Extract to hook?
9. **Accessibility?** → Keyboard-only test, contrast check, alt text audit

**Always pair structural verification with visual measurement.**
