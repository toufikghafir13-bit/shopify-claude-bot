require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { getProducts, getOrderByEmail } = require("./shopify");

const app = express();
const client = new Anthropic();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "LumePath Claude Bot running!" });
});

app.post("/chat", async (req, res) => {
  try {
    const { message, email } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    const products = await getProducts();
    const order = email ? await getOrderByEmail(email) : null;

    const systemPrompt = "You are a helpful store assistant. Only answer questions about our products and orders.\n\nPRODUCTS:\n"
      + products.map(p => "- " + p.title + ": $" + p.price).join("\n")
      + (order ? "\n\nCUSTOMER ORDER: #" + order.order_number + ", Status: " + order.fulfillment_status : "");

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: message }]
    });

    res.json({ reply: response.content[0].text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port " + PORT));
