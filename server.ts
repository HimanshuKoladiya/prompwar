import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { db } from "./src/server-db.js";

const app = express();
const PORT = 3000;

// Body parser with size limits for base64 image uploads
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// Initialize Gemini client on server side
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// --- API ROUTES ---

// 1. User onboarding & profile handling
app.post("/api/users", (req, res) => {
  try {
    const { id, age_group, diet, allergies, health_conditions, daily_budget } = req.body;
    
    if (!id) {
       res.status(400).json({ error: "id is required" });
       return;
    }

    const user = db.upsertUser({
      id,
      age_group: age_group || "Adult",
      diet: diet || "None",
      allergies: Array.isArray(allergies) ? allergies : [],
      health_conditions: Array.isArray(health_conditions) ? health_conditions : [],
      daily_budget: typeof daily_budget === "number" ? daily_budget : 500,
    });

     res.json({ success: true, user });
  } catch (err: any) {
    console.error("Error creating/updating user:", err);
     res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:id", (req, res) => {
  try {
    const user = db.getUser(req.params.id);
    if (!user) {
       res.status(404).json({ error: "User not found" });
       return;
    }
     res.json(user);
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

// 2. Inventory / pantry management
app.get("/api/inventory/:userId", (req, res) => {
  try {
    const items = db.getInventory(req.params.userId);
     res.json(items);
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.post("/api/inventory/:userId", (req, res) => {
  try {
    const { ingredient_name, quantity } = req.body;
    if (!ingredient_name || quantity === undefined) {
       res.status(400).json({ error: "ingredient_name and quantity are required" });
       return;
    }
    const item = db.upsertInventoryItem(req.params.userId, ingredient_name, Number(quantity));
     res.json({ success: true, item });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.delete("/api/inventory/:userId/:itemId", (req, res) => {
  try {
    const success = db.deleteInventoryItem(req.params.userId, req.params.itemId);
    if (success) {
       res.json({ success: true });
    } else {
       res.status(404).json({ error: "Item not found" });
    }
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.post("/api/inventory/:userId/clear", (req, res) => {
  try {
    db.clearInventory(req.params.userId);
     res.json({ success: true });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

// 3. Ingredient pricing table
app.get("/api/pricing", (req, res) => {
  try {
    const pricing = db.getPricing();
     res.json(pricing);
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

app.post("/api/pricing", (req, res) => {
  try {
    const { ingredient_name, est_price_per_100g } = req.body;
    if (!ingredient_name || est_price_per_100g === undefined) {
       res.status(400).json({ error: "ingredient_name and est_price_per_100g are required" });
       return;
    }
    const pricing = db.upsertPricing(ingredient_name, Number(est_price_per_100g));
     res.json({ success: true, pricing });
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

// 4. Meal history
app.get("/api/meal-history/:userId", (req, res) => {
  try {
    const history = db.getMealHistory(req.params.userId);
     res.json(history);
  } catch (err: any) {
     res.status(500).json({ error: err.message });
  }
});

// A. Vision analyze endpoint
app.post("/api/vision/analyze-pantry", async (req, res) => {
  try {
    const { image, user_id } = req.body; // base64 representation of image and optional user_id
    if (!image) {
       res.status(400).json({ error: "image (base64 string) is required" });
       return;
    }

    if (!user_id) {
       res.status(400).json({ error: "user_id is required" });
       return;
    }

    // Prepare content for Gemini API call (gemini-3.5-flash is our standard vision & text model)
    // base64 image data needs to strip data:image/...;base64, if present
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

    const imagePart = {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Data,
      },
    };

    const textPart = {
      text: "Analyze this image (fridge shelf, pantry, or grocery receipt). Identify all individual food ingredients. Output a JSON array of objects with keys: 'ingredient_name' and 'estimated_qty_grams'. Try to estimate the weight in grams accurately, or use sensible default sizes (e.g., tomato = 120 grams, half onion = 60 grams, milk pack = 500 grams, garlic bulb = 50 grams). Formulate of the form: [{\"ingredient_name\": \"Tomato\", \"estimated_qty_grams\": 240}, ...].",
    };

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: { parts: [imagePart, textPart] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              ingredient_name: { type: Type.STRING },
              estimated_qty_grams: { type: Type.NUMBER },
            },
            required: ["ingredient_name", "estimated_qty_grams"],
          },
        },
      },
    });

    const parsedIngredients = JSON.parse(response.text || "[]");

    // Upsert items into inventory table for this user
    const addedItems = [];
    for (const item of parsedIngredients) {
      if (item.ingredient_name && item.estimated_qty_grams) {
        const upserted = db.upsertInventoryItem(
          user_id,
          item.ingredient_name,
          item.estimated_qty_grams
        );
        addedItems.push(upserted);
      }
    }

     res.json({
      success: true,
      raw_analysis: parsedIngredients,
      upserted_items: addedItems,
    });
  } catch (err: any) {
    console.error("Vision analyze failure:", err);
     res.status(500).json({ error: "Pantry vision analysis failed. Please verify your Gemini API key: " + err.message });
  }
});

// B. Planner generate endpoint
app.post("/api/planner/generate", async (req, res) => {
  try {
    const { user_id, language } = req.body;
    const selectedLanguage = language || "English";
    if (!user_id) {
       res.status(400).json({ error: "user_id is required" });
       return;
    }

    const user = db.getUser(user_id);
    if (!user) {
       res.status(404).json({ error: "User onboarding profile not found" });
       return;
    }

    const inventory = db.getInventory(user_id);

    // Format current inventory and prices for prompt
    const formattedInventory = inventory
      .map((item) => `- ${item.ingredient_name}: ${item.quantity}g (Stocked)`)
      .join("\n");

    const pricesList = db.getPricing()
      .map((p) => `- ${p.ingredient_name}: est. ${p.est_price_per_100g} INR/100g`)
      .join("\n");

    const promptText = `
You are the PantryMind AI meal planning engine. Generate a comprehensive daily meal plan (Breakfast, Lunch, Dinner), a micro chronological to-do check list, and a grocery list based strictly on the user criteria.

USER PROFILE:
- Age Group: ${user.age_group}
- Diet: ${user.diet}
- Allergies: ${user.allergies.length > 0 ? user.allergies.join(", ") : "None"}
- Health Conditions: ${user.health_conditions.length > 0 ? user.health_conditions.join(", ") : "None (Adhere to healthy balanced meals)"}
- Daily Budget: ${user.daily_budget} INR

CURRENT INVENTORY IN THE FRIDGE/PANTRY:
${formattedInventory || "The fridge and pantry are empty! Prepare a plan relying fully on grocery lists."}

INGREDIENT PRICING DATA:
${pricesList}

LANGUAGE PREFERENCE:
- Please write all readable textual content in: ${selectedLanguage}. For example: Names of dishes, list tasks, grocery details, benefits, and instructions must be completely generated in ${selectedLanguage} (using its script/characters or localized words) so speakers of ${selectedLanguage} find it extremely warm and accessible.

INSTRUCTIONS:
1. Formulate 3 meals matching the user's diet, strictly avoiding any listed allergies.
2. Adhere to health conditions (e.g. low GI for Diabetes, low sodium for Hypertension/High Blood Pressure, low fats etc). Check health conditions and formulate specific health benefits.
3. Keep the total estimated ingredient cost of grocery items plus proportional stocked items within the Daily Budget (${user.daily_budget} INR).
4. Identify which ingredients are present in the pantry (is_in_fridge: true) and which need to be purchased (is_in_fridge: false). Estimate the cost of non-fridge items to build the budget value.
5. Create a chronological task checklist with appropriate tags like "Morning" / "Afternoon" / "Evening". For example: "Marinate chicken in afternoon before cooking dinner." Or "Soak rice while preparation for breakfast is happening."
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: promptText,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            daily_plan: {
              type: Type.OBJECT,
              properties: {
                breakfast: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    prep_time_mins: { type: Type.INTEGER },
                    health_benefit: { type: Type.STRING },
                  },
                  required: ["name", "prep_time_mins", "health_benefit"],
                },
                lunch: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    prep_time_mins: { type: Type.INTEGER },
                    health_benefit: { type: Type.STRING },
                  },
                  required: ["name", "prep_time_mins", "health_benefit"],
                },
                dinner: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    prep_time_mins: { type: Type.INTEGER },
                    health_benefit: { type: Type.STRING },
                  },
                  required: ["name", "prep_time_mins", "health_benefit"],
                },
              },
              required: ["breakfast", "lunch", "dinner"],
            },
            chronological_todo_list: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  task: { type: Type.STRING },
                  time_tag: { type: Type.STRING },
                },
                required: ["task", "time_tag"],
              },
            },
            grocery_list: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  item: { type: Type.STRING },
                  qty: { type: Type.STRING },
                  est_cost_inr: { type: Type.NUMBER },
                  is_in_fridge: { type: Type.BOOLEAN },
                },
                required: ["item", "qty", "est_cost_inr", "is_in_fridge"],
              },
            },
            total_budget_used: { type: Type.NUMBER },
          },
          required: ["daily_plan", "chronological_todo_list", "grocery_list", "total_budget_used"],
        },
      },
    });

    const mealPlan = JSON.parse(response.text || "{}");

    // Persist this generated meal plan in the history!
    db.addMealHistory(user_id, mealPlan, mealPlan.total_budget_used || 0);

     res.json(mealPlan);
  } catch (err: any) {
    console.error("Meal planning failure:", err);
     res.status(500).json({ error: "Failed to generate meal plan: " + err.message });
  }
});

// C. Planner substitute endpoint
app.post("/api/planner/substitute", async (req, res) => {
  try {
    const { ingredient_to_swap, user_id, recipe_context, language } = req.body;
    const selectedLanguage = language || "English";
    if (!ingredient_to_swap || !user_id) {
       res.status(400).json({ error: "ingredient_to_swap and user_id are required" });
       return;
    }

    const user = db.getUser(user_id);
    const allergies = user ? user.allergies : [];
    const diet = user ? user.diet : "None";

    const promptText = `
You are the PantryMind AI Swap specialist. Provide an ideal substitute or alternative ingredient for: "${ingredient_to_swap}". 
The swap must respect:
- Allergies to strictly avoid: ${allergies.join(", ") || "None"}
- Diet preference: ${diet}
- Recipe context: ${recipe_context || "General cooking"}

LANGUAGE PREFERENCE:
- Please output all readable values generated (substitute_name, reason, alternative_recipe_steps_brief) in: ${selectedLanguage}.

Please return a valid JSON object matching this schema:
{
  "substitute_name": "Name of recommended substitute ingredient",
  "reason": "Why this is an excellent swap (health/diet/cost benefit)",
  "cost_difference_inr": -15.0, // savings (negative) or additional cost (positive) in INR
  "alternative_recipe_steps_brief": "Brief instructions on how to use this replacement in the meal"
}
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: promptText,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            substitute_name: { type: Type.STRING },
            reason: { type: Type.STRING },
            cost_difference_inr: { type: Type.NUMBER },
            alternative_recipe_steps_brief: { type: Type.STRING },
          },
          required: ["substitute_name", "reason", "cost_difference_inr", "alternative_recipe_steps_brief"],
        },
      },
    });

    const parsedResponse = JSON.parse(response.text || "{}");
     res.json(parsedResponse);
  } catch (err: any) {
    console.error("Substitution failure:", err);
     res.status(500).json({ error: "Failed to substitute ingredient: " + err.message });
  }
});

// --- VITE MIDDLEWARE SETUP ---
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PantryMind Express backend running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
