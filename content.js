// BrowseClaw Content Script
// Runs in the context of web pages — provides DOM reading and manipulation tools

(() => {
  // Prevent double injection
  if (window.__chromeclaw_injected) return;
  window.__chromeclaw_injected = true;

  // Highlight overlay management
  const highlights = [];

  // ─── Message Handler ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = handlers[message.action];
    if (handler) {
      try {
        const result = handler(message);
        if (result && typeof result.then === 'function') {
          result
            .then(data => sendResponse({ success: true, data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        } else {
          sendResponse({ success: true, data: result });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    } else if (message.action === 'ping') {
      sendResponse({ pong: true });
    } else {
      sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    }
    return true;
  });

  // ─── Tool Handlers ───────────────────────────────────────────────────────────
  const handlers = {

    // ── Page Reading ──────────────────────────────────────────────────────────

    get_page_content: ({ max_length }) => {
      let text = document.body.innerText || '';
      if (max_length && text.length > max_length) {
        text = text.substring(0, max_length) + '\n... [truncated]';
      }
      return { content: text, length: text.length };
    },

    get_page_metadata: () => {
      const meta = {};
      document.querySelectorAll('meta').forEach(m => {
        const key = m.getAttribute('name') || m.getAttribute('property');
        if (key) meta[key] = m.getAttribute('content');
      });

      const headings = [];
      document.querySelectorAll('h1, h2, h3').forEach(h => {
        headings.push({ level: parseInt(h.tagName[1]), text: h.innerText.trim() });
      });

      return {
        title: document.title,
        url: location.href,
        description: meta['description'] || meta['og:description'] || '',
        headings: headings.slice(0, 30),
        meta
      };
    },

    get_page_context: ({ max_length }) => {
      const meta = handlers.get_page_metadata();
      let text = document.body.innerText || '';
      const limit = max_length || 8000;
      if (text.length > limit) {
        text = text.substring(0, limit) + '\n... [truncated]';
      }
      return {
        title: meta.title || document.title,
        url: location.href,
        content: text,
        headings: meta.headings || [],
        forms: handlers.get_form_fields().length,
        links: document.querySelectorAll('a[href]').length
      };
    },

    get_selected_text: () => {
      const selection = window.getSelection();
      return { text: selection ? selection.toString() : '' };
    },

    // ── Element Querying ──────────────────────────────────────────────────────

    query_elements: ({ selector, limit }) => {
      const elements = Array.from(document.querySelectorAll(selector));
      const maxElements = limit || 20;
      return elements.slice(0, maxElements).map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: el.className || undefined,
        text: el.innerText?.substring(0, 200)?.trim() || undefined,
        href: el.href || undefined,
        src: el.src || undefined,
        value: el.value || undefined,
        type: el.type || undefined,
        visible: isVisible(el),
        rect: el.getBoundingClientRect().toJSON()
      }));
    },

    find_element_by_text: ({ text, tag }) => {
      const selector = tag || '*';
      const elements = Array.from(document.querySelectorAll(selector));
      const found = elements.filter(el => {
        const elText = el.innerText?.trim() || el.value || el.placeholder || '';
        return elText.toLowerCase().includes(text.toLowerCase());
      });
      return found.slice(0, 10).map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: el.className || undefined,
        text: el.innerText?.substring(0, 200)?.trim() || undefined,
        selector: getUniqueSelector(el)
      }));
    },

    // ── Element Interaction ───────────────────────────────────────────────────

    click_element: ({ selector, text }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Element not found: ${selector || text}`);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashElement(el);
      el.click();
      return { clicked: true, tag: el.tagName.toLowerCase(), text: el.innerText?.substring(0, 100) };
    },

    fill_input: ({ selector, text, value }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Input not found: ${selector || text}`);

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      flashElement(el);

      // Check if it's a contenteditable element (WhatsApp, Slack, Discord, etc.)
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
        // Clear and type into contenteditable
        el.textContent = '';
        el.focus();
        // Use insertText command for best compatibility with web apps
        document.execCommand('insertText', false, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { filled: true, contenteditable: true, selector: getUniqueSelector(el) };
      }

      // Standard input/textarea
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));

      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Also try setting via native input setter for React/Vue
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return { filled: true, selector: getUniqueSelector(el) };
    },

    // Type text character-by-character with keyboard events (for contenteditable and complex inputs)
    type_keyboard: ({ selector, text, value }) => {
      const el = selector ? findElement(selector, text) : document.activeElement;
      if (!el) throw new Error(`Element not found: ${selector || text || 'no active element'}`);

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();

      const textToType = value || '';
      // Use insertText for best compatibility
      document.execCommand('insertText', false, textToType);
      el.dispatchEvent(new Event('input', { bubbles: true }));

      return { typed: true, length: textToType.length, selector: getUniqueSelector(el) };
    },

    select_option: ({ selector, value, option_text }) => {
      const el = selector ? document.querySelector(selector) : document.querySelector('select');
      if (!el || el.tagName !== 'SELECT') throw new Error(`Select not found: ${selector}`);

      const options = Array.from(el.options);
      const option = options.find(o =>
        (value && o.value === value) ||
        (option_text && o.text.toLowerCase().includes(option_text.toLowerCase()))
      );

      if (!option) throw new Error(`Option not found: ${value || option_text}`);

      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flashElement(el);
      return { selected: true, value: option.value, text: option.text };
    },

    check_element: ({ selector, text, checked }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Element not found: ${selector || text}`);
      el.checked = checked !== false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flashElement(el);
      return { checked: el.checked };
    },

    submit_form: ({ selector }) => {
      const form = selector ? document.querySelector(selector) : document.querySelector('form');
      if (!form) throw new Error('Form not found');
      form.submit();
      return { submitted: true };
    },

    press_key: ({ key, selector }) => {
      const target = selector ? document.querySelector(selector) : document.activeElement || document.body;
      const event = new KeyboardEvent('keydown', {
        key, code: key, bubbles: true, cancelable: true
      });
      target.dispatchEvent(event);
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key, code: key, bubbles: true, cancelable: true
      }));
      return { pressed: key };
    },

    // ── Scrolling ─────────────────────────────────────────────────────────────

    scroll_page: ({ direction, amount, selector }) => {
      if (selector) {
        const el = document.querySelector(selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          flashElement(el);
          return { scrolled: true, to: selector };
        }
      }
      const px = amount || 500;
      const map = { up: -px, down: px, top: -document.body.scrollHeight, bottom: document.body.scrollHeight };
      window.scrollBy({ top: map[direction] || px, behavior: 'smooth' });
      return { scrolled: true, direction };
    },

    // ── Data Extraction ───────────────────────────────────────────────────────

    get_form_fields: () => {
      const fields = [];
      document.querySelectorAll('input, textarea, select').forEach(el => {
        if (el.type === 'hidden') return;
        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || undefined,
          name: el.name || undefined,
          id: el.id || undefined,
          placeholder: el.placeholder || undefined,
          value: el.value || undefined,
          label: getLabel(el),
          required: el.required || undefined,
          options: el.tagName === 'SELECT'
            ? Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }))
            : undefined,
          selector: getUniqueSelector(el)
        });
      });
      return fields;
    },

    extract_table_data: ({ selector }) => {
      const table = selector ? document.querySelector(selector) : document.querySelector('table');
      if (!table) throw new Error('Table not found');

      const headers = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th'))
        .map(th => th.innerText.trim());

      const rows = [];
      table.querySelectorAll('tbody tr, tr').forEach((tr, i) => {
        if (i === 0 && headers.length > 0) return;
        const cells = Array.from(tr.querySelectorAll('td, th')).map(td => td.innerText.trim());
        if (cells.length > 0) rows.push(cells);
      });

      return { headers, rows, rowCount: rows.length };
    },

    get_links: ({ filter, limit }) => {
      let links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: a.innerText?.trim()?.substring(0, 100),
        href: a.href,
        selector: getUniqueSelector(a)
      }));

      if (filter) {
        const f = filter.toLowerCase();
        links = links.filter(l =>
          l.text?.toLowerCase().includes(f) || l.href?.toLowerCase().includes(f)
        );
      }

      return links.slice(0, limit || 50);
    },

    extract_structured_data: ({ selector, fields }) => {
      const containers = Array.from(document.querySelectorAll(selector));
      return containers.slice(0, 50).map(container => {
        const item = {};
        for (const [key, sel] of Object.entries(fields)) {
          const el = container.querySelector(sel);
          item[key] = el ? (el.innerText?.trim() || el.value || el.src || el.href) : null;
        }
        return item;
      });
    },

    // ── Visual Feedback ───────────────────────────────────────────────────────

    highlight_elements: ({ selector, color }) => {
      clearHighlights();
      const elements = Array.from(document.querySelectorAll(selector));
      elements.slice(0, 20).forEach(el => {
        const overlay = document.createElement('div');
        const rect = el.getBoundingClientRect();
        Object.assign(overlay.style, {
          position: 'fixed',
          top: rect.top + 'px',
          left: rect.left + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px',
          backgroundColor: color || 'rgba(255, 107, 53, 0.3)',
          border: `2px solid ${color || 'rgba(255, 107, 53, 0.8)'}`,
          borderRadius: '4px',
          zIndex: 2147483647,
          pointerEvents: 'none',
          transition: 'opacity 0.3s'
        });
        document.body.appendChild(overlay);
        highlights.push(overlay);
      });
      return { highlighted: elements.length };
    },

    clear_highlights: () => {
      clearHighlights();
      return { cleared: true };
    },

    // ── Mouse Actions ─────────────────────────────────────────────────────────

    double_click: ({ selector, text }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Element not found: ${selector || text}`);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashElement(el);
      ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
      });
      return { doubleClicked: true, selector: getUniqueSelector(el) };
    },

    right_click: ({ selector, text }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Element not found: ${selector || text}`);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2 }));
      return { rightClicked: true, selector: getUniqueSelector(el) };
    },

    hover: ({ selector, text }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Element not found: ${selector || text}`);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
      return { hovered: true, selector: getUniqueSelector(el) };
    },

    get_rect: ({ selector, text }) => {
      const el = findElement(selector, text);
      if (!el) throw new Error(`Element not found: ${selector || text}`);
      const rect = el.getBoundingClientRect();
      return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height };
    },

    // Drag from (fromX, fromY) to (toX, toY) in viewport coordinates.
    // Use get_rect first to compute coordinates relative to an element.
    drag: ({ fromX, fromY, toX, toY, selector, steps }) => {
      const numSteps = steps || 20;

      function fire(el, type, x, y, buttons) {
        const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons };
        el.dispatchEvent(new PointerEvent('pointer' + { mousedown: 'down', mousemove: 'move', mouseup: 'up' }[type], { ...init, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent(type, init));
      }

      // If selector given, compute fromX/toX relative to that element's top-left corner
      if (selector) {
        const el = document.querySelector(selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          fromX = rect.left + (fromX || 0);
          fromY = rect.top + (fromY || 0);
          toX = rect.left + (toX || rect.width);
          toY = rect.top + (toY || rect.height);
        }
      }

      const startEl = document.elementFromPoint(fromX, fromY) || document.body;
      fire(startEl, 'mousedown', fromX, fromY, 1);

      for (let i = 1; i <= numSteps; i++) {
        const x = fromX + (toX - fromX) * (i / numSteps);
        const y = fromY + (toY - fromY) * (i / numSteps);
        const el = document.elementFromPoint(x, y) || startEl;
        fire(el, 'mousemove', x, y, 1);
      }

      const endEl = document.elementFromPoint(toX, toY) || startEl;
      fire(endEl, 'mouseup', toX, toY, 0);

      return { dragged: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
    },

    // ── Waiting ───────────────────────────────────────────────────────────────

    // ── Debug Overlays ────────────────────────────────────────────────────────

    debug_cursor: ({ x, y }) => {
      _dbgEnsureStyles();
      let el = document.getElementById('__cc_cursor__');
      if (!el) {
        el = document.createElement('div');
        el.id = '__cc_cursor__';
        Object.assign(el.style, {
          position: 'fixed', width: '14px', height: '14px', borderRadius: '50%',
          background: '#FF6B35', border: '2px solid #fff',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          transform: 'translate(-50%,-50%)', pointerEvents: 'none',
          zIndex: '2147483647', transition: 'left 0.12s ease, top 0.12s ease'
        });
        document.body.appendChild(el);
      }
      el.style.left = x + 'px'; el.style.top = y + 'px';
      return { ok: true };
    },

    debug_highlight: ({ selector }) => {
      _dbgEnsureStyles();
      document.querySelectorAll('.__cc_hl__').forEach(e => e.remove());
      const target = selector ? document.querySelector(selector) : null;
      if (!target) return { ok: false };
      const rect = target.getBoundingClientRect();
      const hl = document.createElement('div');
      hl.className = '__cc_hl__';
      Object.assign(hl.style, {
        position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
        top: rect.top + 'px', left: rect.left + 'px',
        width: rect.width + 'px', height: rect.height + 'px',
        border: '2px solid #FF6B35', borderRadius: '4px',
        background: 'rgba(255,107,53,0.12)',
        boxShadow: '0 0 0 4px rgba(255,107,53,0.25)',
        animation: '__cc_pulse__ 0.7s ease infinite'
      });
      document.body.appendChild(hl);
      return { ok: true, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } };
    },

    debug_ripple: ({ x, y }) => {
      _dbgEnsureStyles();
      const el = document.createElement('div');
      Object.assign(el.style, {
        position: 'fixed', width: '48px', height: '48px', borderRadius: '50%',
        border: '2.5px solid #FF6B35', left: x + 'px', top: y + 'px',
        pointerEvents: 'none', zIndex: '2147483647',
        animation: '__cc_ripple__ 0.55s ease-out forwards'
      });
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 600);
      return { ok: true };
    },

    debug_label: ({ x, y, text }) => {
      _dbgEnsureStyles();
      document.querySelectorAll('.__cc_lbl__').forEach(e => e.remove());
      const el = document.createElement('div');
      el.className = '__cc_lbl__';
      // Keep label inside viewport
      const safeX = Math.min(Math.max(x, 60), window.innerWidth - 60);
      const safeY = y < 36 ? y + 28 : y - 32;
      Object.assign(el.style, {
        position: 'fixed', left: safeX + 'px', top: safeY + 'px',
        transform: 'translateX(-50%)',
        background: 'rgba(20,20,24,0.92)', color: '#FF6B35',
        border: '1px solid rgba(255,107,53,0.5)',
        padding: '3px 9px', borderRadius: '10px',
        fontSize: '11px', fontFamily: 'monospace',
        whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: '2147483647',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis'
      });
      el.textContent = text;
      document.body.appendChild(el);
      return { ok: true };
    },

    debug_drag_path: ({ fromX, fromY, toX, toY }) => {
      _dbgEnsureStyles();
      document.querySelectorAll('.__cc_drag__').forEach(e => e.remove());
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', '__cc_drag__');
      Object.assign(svg.style, {
        position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
        pointerEvents: 'none', zIndex: '2147483646', overflow: 'visible'
      });
      const ns = 'http://www.w3.org/2000/svg';
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', fromX); line.setAttribute('y1', fromY);
      line.setAttribute('x2', toX); line.setAttribute('y2', toY);
      line.setAttribute('stroke', '#FF6B35'); line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6 4'); line.setAttribute('opacity', '0.85');
      const mkCircle = (cx, cy, fill, stroke) => {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '7');
        c.setAttribute('fill', fill); c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', '2');
        return c;
      };
      const mkLabel = (x, y, text) => {
        const bg = document.createElementNS(ns, 'rect');
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', x + 12); t.setAttribute('y', y - 6);
        t.setAttribute('fill', '#FF6B35'); t.setAttribute('font-size', '10');
        t.setAttribute('font-family', 'monospace'); t.textContent = text;
        return [t];
      };
      svg.appendChild(line);
      svg.appendChild(mkCircle(fromX, fromY, '#FF6B35', '#fff'));
      svg.appendChild(mkCircle(toX, toY, '#fff', '#FF6B35'));
      mkLabel(fromX, fromY, `(${Math.round(fromX)},${Math.round(fromY)})`).forEach(e => svg.appendChild(e));
      mkLabel(toX, toY, `(${Math.round(toX)},${Math.round(toY)})`).forEach(e => svg.appendChild(e));
      document.body.appendChild(svg);
      return { ok: true };
    },

    debug_clear: () => {
      document.querySelectorAll('.__cc_hl__, .__cc_lbl__, .__cc_drag__, #__cc_cursor__').forEach(e => e.remove());
      return { ok: true };
    },

    // ── Active Element / Focus State ──────────────────────────────────────────

    get_focused_element: () => {
      const el = document.activeElement;
      if (!el || el === document.body) return { focused: false };

      // Also find any aria-current or visually-active chat/item
      const activeCurrent = document.querySelector('[aria-current="true"],[aria-selected="true"],.active,[data-active="true"]');

      return {
        focused: true,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: el.className || undefined,
        contenteditable: el.isContentEditable || el.getAttribute('contenteditable') === 'true' || undefined,
        placeholder: el.placeholder || el.getAttribute('aria-placeholder') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        selector: getUniqueSelector(el),
        text: el.innerText?.substring(0, 100)?.trim() || el.value?.substring(0, 100) || undefined,
        activeSectionLabel: activeCurrent ? (activeCurrent.getAttribute('aria-label') || activeCurrent.innerText?.substring(0, 80)?.trim()) : undefined
      };
    },

    wait_for_element: ({ selector, timeout }) => {
      return new Promise((resolve) => {
        const el = document.querySelector(selector);
        if (el) return resolve({ found: true });

        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            resolve({ found: true });
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false, timeout: true });
        }, timeout || 5000);
      });
    }
  };

  // ─── Helper Functions ─────────────────────────────────────────────────────

  function findElement(selector, text) {
    if (selector) {
      return document.querySelector(selector);
    }
    if (text) {
      const all = Array.from(document.querySelectorAll('*'));
      return all.find(el => {
        const t = el.innerText?.trim() || el.value || el.placeholder || '';
        return t.toLowerCase().includes(text.toLowerCase()) && el.children.length === 0;
      });
    }
    return null;
  }

  function getUniqueSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
        selector += cls;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getLabel(input) {
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.innerText.trim();
    }
    const parent = input.closest('label');
    if (parent) return parent.innerText.trim();
    const prev = input.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.innerText.trim();
    return input.getAttribute('aria-label') || undefined;
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function flashElement(el) {
    const original = el.style.outline;
    el.style.outline = '3px solid #FF6B35';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = original;
      el.style.outlineOffset = '';
    }, 1500);
  }

  function _dbgEnsureStyles() {
    if (document.getElementById('__cc_dbg_styles__')) return;
    const s = document.createElement('style');
    s.id = '__cc_dbg_styles__';
    s.textContent = `
      @keyframes __cc_pulse__ {
        0%,100% { box-shadow: 0 0 0 4px rgba(255,107,53,0.25); }
        50%      { box-shadow: 0 0 0 9px rgba(255,107,53,0.08); }
      }
      @keyframes __cc_ripple__ {
        from { transform: translate(-50%,-50%) scale(0.2); opacity: 1; }
        to   { transform: translate(-50%,-50%) scale(2.8); opacity: 0; }
      }
    `;
    document.head.appendChild(s);
  }

  function clearHighlights() {
    highlights.forEach(h => h.remove());
    highlights.length = 0;
  }
})();
