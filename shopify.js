require("dotenv").config();
const fetch = require("node-fetch");

const BASE = "https://" + process.env.SHOPIFY_DOMAIN + "/admin/api/2024-01";
const HDR = {
  "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
  "Content-Type": "application/json"
};

async function getProducts() {
  const r = await fetch(BASE + "/products.json?limit=50&fields=title,variants", { headers: HDR });
  const d = await r.json();
  return d.products.map(p => ({
    title: p.title,
    price: p.variants[0]?.price || "N/A"
  }));
}

async function getOrderByEmail(email) {
  const r = await fetch(BASE + "/orders.json?email=" + encodeURIComponent(email) + "&status=any&limit=1", { headers: HDR });
  const d = await r.json();
  return d.orders?.[0] || null;
}

module.exports = { getProducts, getOrderByEmail };
