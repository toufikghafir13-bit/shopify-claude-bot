require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { getProducts, getOrderByEmail } = require("./shopify");

const app = express();
const client = new Anthropic();
const ADMIN_KEY = process.env.ADMIN_KEY || "lumepath-admin-2026";
const DOMAIN = process.env.SHOPIFY_DOMAIN;
const TOKEN = process.env.SHOPIFY_TOKEN;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => { res.json({ status: "LumePath Claude Bot running!" }); });

// ── CUSTOMER CHAT ──────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { message, email } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const products = await getProducts();
    let context = "Products:\n" + products.map(p => `- ${p.title} (${p.variants?.[0]?.price || "N/A"})`).join("\n");
    if (email) { const order = await getOrderByEmail(email); if (order) context += "\nOrder: " + JSON.stringify(order); }
    const response = await client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 512, messages: [{ role: "user", content: `You are a helpful assistant for LumePath store. Store data:\n${context}\n\nCustomer: ${message}` }] });
    res.json({ reply: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: AUTH MIDDLEWARE ──────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || req.body?.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function shopifyRequest(method, path, body) {
  const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
  const url = `https://${DOMAIN}/admin/api/2024-01/${path}`;
  const resp = await fetch(url, { method, headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return resp.json();
}

// ── ADMIN: AI COMMAND (natural language) ───────────────────────
app.post("/admin/command", adminAuth, async (req, res) => {
  try {
    const { command } = req.body;
    const products = await getProducts();
    const productList = products.map(p => `ID:${p.id} | ${p.title} | Price:${p.variants?.[0]?.price} | Variant:${p.variants?.[0]?.id}`).join("\n");
    const systemPrompt = `You are an AI assistant managing a Shopify store. You have these tools available:
- CREATE_PRODUCT: title, price, description, inventory
- UPDATE_PRICE: product_id, variant_id, new_price
- UPDATE_INVENTORY: variant_id, quantity, location_id
- DELETE_PRODUCT: product_id
- GET_PRODUCTS: (no params)
- GET_ORDERS: status (any/open/closed)
- FULFILL_ORDER: order_id, tracking_number, tracking_company
- CREATE_DISCOUNT: title, percentage, code
- AI_REPLY: message (for general questions)

Current products:
${productList}

Respond with ONLY a JSON object like: {"action": "ACTION_NAME", "params": {...}, "message": "what you did"}
Do not add any other text.`;
    const response = await client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 512, messages: [{ role: "user", content: `${systemPrompt}\n\nAdmin command: ${command}` }] });
    const text = response.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { return res.json({ message: text, action: "AI_REPLY" }); }
    const result = await executeAction(parsed);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function executeAction({ action, params }) {
  switch (action) {
    case "GET_PRODUCTS": { const p = await getProducts(); return { message: `Found ${p.length} products`, data: p.map(x => ({ id: x.id, title: x.title, price: x.variants?.[0]?.price })) }; }
    case "CREATE_PRODUCT": { const r = await shopifyRequest("POST", "products.json", { product: { title: params.title, body_html: params.description || "", variants: [{ price: String(params.price), inventory_quantity: params.inventory || 0 }] } }); return { message: `Created: ${r.product?.title}`, id: r.product?.id }; }
    case "UPDATE_PRICE": { const r = await shopifyRequest("PUT", `variants/${params.variant_id}.json`, { variant: { id: params.variant_id, price: String(params.new_price) } }); return { message: `Price updated to $${params.new_price}` }; }
    case "DELETE_PRODUCT": { await shopifyRequest("DELETE", `products/${params.product_id}.json`); return { message: "Product deleted" }; }
    case "GET_ORDERS": { const r = await shopifyRequest("GET", `orders.json?status=${params.status || "any"}&limit=20`); return { message: `Found ${r.orders?.length} orders`, data: r.orders?.map(o => ({ id: o.id, name: o.name, total: o.total_price, status: o.fulfillment_status, email: o.email })) }; }
    case "FULFILL_ORDER": { const r = await shopifyRequest("POST", `orders/${params.order_id}/fulfillments.json`, { fulfillment: { tracking_number: params.tracking_number, tracking_company: params.tracking_company || "Other", notify_customer: true } }); return { message: `Order ${params.order_id} fulfilled` }; }
    case "CREATE_DISCOUNT": { const r = await shopifyRequest("POST", "price_rules.json", { price_rule: { title: params.title, target_type: "line_item", target_selection: "all", allocation_method: "across", value_type: "percentage", value: `-${params.percentage}`, customer_selection: "all", starts_at: new Date().toISOString() } }); if (r.price_rule) { const c = await shopifyRequest("POST", `price_rules/${r.price_rule.id}/discount_codes.json`, { discount_code: { code: params.code } }); return { message: `Discount ${params.code} (${params.percentage}% off) created!` }; } return { message: "Failed to create discount", error: r }; }
    default: return { message: "Action not recognized: " + action };
  }
}

// ── ADMIN: SIMPLE PANEL ────────────────────────────────────────
app.get("/admin", (req, res) => {
  const key = req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).send("Unauthorized");
  res.send(`<!DOCTYPE html><html><head><title>LumePath Admin</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#f5f5f5;padding:16px}h1{color:#5c6ac4;margin-bottom:16px;font-size:20px}.chat{background:#fff;border-radius:12px;padding:16px;max-width:600px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.1)}#msgs{height:400px;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}.msg{padding:10px 14px;border-radius:10px;max-width:90%;font-size:14px;line-height:1.4}.bot{background:#f0f0f0;align-self:flex-start}.user{background:#5c6ac4;color:#fff;align-self:flex-end}.row{display:flex;gap:8px;margin-top:12px}input{flex:1;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px}button{background:#5c6ac4;color:#fff;border:none;border-radius:8px;padding:10px 18px;cursor:pointer;font-size:14px}</style></head><body><div class="chat"><h1>🤖 LumePath Admin AI</h1><div id="msgs"><div class="msg bot">Hi! I can manage your store. Try: "add product Solar Panel $49", "show all orders", "create 20% discount code SAVE20", "update price of [product] to $99"</div></div><div class="row"><input id="inp" placeholder="Type a command..." onkeydown="if(event.key==='Enter')send()"/><button onclick="send()">Send</button></div></div><script>async function send(){const i=document.getElementById('inp');const m=document.getElementById('msgs');const t=i.value.trim();if(!t)return;i.value='';m.innerHTML+='<div class="msg user">'+t+'</div>';const th=document.createElement('div');th.className='msg bot';th.textContent='Working...';m.appendChild(th);m.scrollTop=m.scrollHeight;const r=await fetch('/admin/command',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':'${ADMIN_KEY}'},body:JSON.stringify({command:t})});const d=await r.json();th.innerHTML='<b>'+(d.message||d.error)+'</b>'+(d.data?'<br><pre style="font-size:11px;margin-top:6px;white-space:pre-wrap">'+JSON.stringify(d.data,null,2)+'</pre>':'');m.scrollTop=m.scrollHeight;}</script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
