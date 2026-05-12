import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const MealSchema = z.object({
  name: z.string(),
  description: z.string(),
  protein_g_per_person: z.number().int(),
  calories_per_person: z.number().int(),
  prep_time_minutes: z.number().int(),
  ingredients: z.array(z.string()),
});

const DayPlanSchema = z.object({
  day: z.string(),
  lunch: MealSchema,
  dinner: MealSchema,
});

const GrocerySectionSchema = z.object({
  section: z.string(),
  items: z.array(z.string()),
});

const WeeklyMealPlanSchema = z.object({
  week_of: z.string(),
  variety_note: z.string(),
  days: z.array(DayPlanSchema),
  grocery_list: z.array(GrocerySectionSchema),
});

type WeeklyMealPlan = z.infer<typeof WeeklyMealPlanSchema>;

function getWeekStart(): string {
  const today = new Date();
  const day = today.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

function planExists(plansDir: string, weekStart: string): boolean {
  return fs.existsSync(path.join(plansDir, `week_${weekStart}.txt`));
}

function extractJson(text: string): string {
  text = text.trim();
  if (text.includes("```json")) {
    text = text.split("```json")[1].split("```")[0];
  } else if (text.includes("```")) {
    text = text.split("```")[1].split("```")[0];
  }
  return text.trim();
}

function makeClient(): Anthropic {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (authToken) {
    return new Anthropic({ authToken });
  }
  return new Anthropic();
}

async function generatePlan(staples: object, weekStart: string): Promise<WeeklyMealPlan> {
  const client = makeClient();

  const system = `You are a personal meal planner for a couple: Steph and her partner.

DAILY TARGETS PER PERSON (lunch + dinner combined):
- ~1,400 calories from lunch and dinner (light breakfast handled separately)
- ~110-120g protein from lunch and dinner
- Lunch target: ~500-600 cal / 40-50g protein per person
- Dinner target: ~700-800 cal / 70-80g protein per person

THEIR STYLE:
- Simple, clean, healthy, genuinely tasty — not fancy
- Quick prep: most meals 30 min or under
- Consistency is key — they love their staples, but are getting a little bored
- Include 1-2 new or varied meals this week to keep things interesting
- No exotic or difficult-to-find ingredients

THEIR REGULAR STAPLES AND PREFERENCES:
${JSON.stringify(staples, null, 2)}

GROCERY LIST RULES:
- Consolidate all ingredients across the full week (don't list chicken 7 times)
- Include exact quantities for 2 people for the entire week
- Organize into exactly these sections: Produce, Meat & Fish, Dairy & Eggs, Pantry, Frozen
- Use preferred brands from the staples list where specified
- Do NOT include pantry_staples.always_on_hand or pantry_staples.fridge_staples items

OUTPUT: Return ONLY valid JSON. No markdown, no explanation, no preamble.`;

  const userMessage = `Plan meals for the week of ${weekStart} (Monday through Sunday).

Return this exact JSON structure:
{
  "week_of": "${weekStart}",
  "variety_note": "One sentence describing what's new or varied this week",
  "days": [
    {
      "day": "Monday",
      "lunch": {
        "name": "Meal Name",
        "description": "Brief appetizing description",
        "protein_g_per_person": 45,
        "calories_per_person": 520,
        "prep_time_minutes": 20,
        "ingredients": ["ingredient with quantity for 2 people", "..."]
      },
      "dinner": { "name": "...", "description": "...", "protein_g_per_person": 75, "calories_per_person": 750, "prep_time_minutes": 25, "ingredients": ["..."] }
    }
  ],
  "grocery_list": [
    { "section": "Produce", "items": ["3 heads broccoli", "..."] },
    { "section": "Meat & Fish", "items": ["..."] },
    { "section": "Dairy & Eggs", "items": ["..."] },
    { "section": "Pantry", "items": ["..."] },
    { "section": "Frozen", "items": ["..."] }
  ]
}

Include all 7 days (Monday through Sunday).`;

  console.log("  Calling Claude...");

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text block in response");
  }

  const jsonStr = extractJson(textBlock.text);
  const parsed = WeeklyMealPlanSchema.safeParse(JSON.parse(jsonStr));
  if (!parsed.success) {
    console.error("\nFailed to parse meal plan:", parsed.error.message);
    console.error("Raw response:", jsonStr.slice(0, 500));
    throw new Error("Invalid meal plan response");
  }

  return parsed.data;
}

function formatPlan(plan: WeeklyMealPlan): string {
  const width = 58;
  const border = "=".repeat(width);
  const thin = "-".repeat(width);

  let weekLabel = plan.week_of;
  try {
    const dt = new Date(plan.week_of + "T12:00:00");
    weekLabel = dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  } catch {}

  const lines: string[] = [
    border,
    `  WEEKLY MEAL PLAN  |  Week of ${weekLabel}`,
    border,
    "",
    `  ${plan.variety_note}`,
    "",
  ];

  for (const day of plan.days) {
    const { lunch, dinner } = day;
    const dayCal = lunch.calories_per_person + dinner.calories_per_person;
    const dayPro = lunch.protein_g_per_person + dinner.protein_g_per_person;

    lines.push(
      thin,
      `  ${day.day.toUpperCase()}  |  ${dayCal.toLocaleString()} cal  |  ${dayPro}g protein`,
      thin,
      "",
      `  LUNCH  [${lunch.prep_time_minutes} min]  ${lunch.calories_per_person} cal  |  ${lunch.protein_g_per_person}g protein`,
      `  ${lunch.name}`,
      `  ${lunch.description}`,
      "",
      `  DINNER  [${dinner.prep_time_minutes} min]  ${dinner.calories_per_person} cal  |  ${dinner.protein_g_per_person}g protein`,
      `  ${dinner.name}`,
      `  ${dinner.description}`,
      "",
    );
  }

  lines.push(border, "  GROCERY LIST", border, "");

  for (const section of plan.grocery_list) {
    if (section.items.length > 0) {
      lines.push(`  ${section.section.toUpperCase()}`);
      for (const item of section.items) {
        lines.push(`    - ${item}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function savePlan(plansDir: string, plan: WeeklyMealPlan): string {
  fs.mkdirSync(plansDir, { recursive: true });
  const base = path.join(plansDir, `week_${plan.week_of}`);
  fs.writeFileSync(base + ".json", JSON.stringify(plan, null, 2));
  const txt = formatPlan(plan);
  fs.writeFileSync(base + ".txt", txt);
  return base + ".txt";
}

async function main() {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const staplesPath = path.join(baseDir, "staples.json");
  const plansDir = path.join(baseDir, "plans");

  if (!fs.existsSync(staplesPath)) {
    console.error(`Error: staples.json not found at ${staplesPath}`);
    console.error("Edit staples.json with your regular foods and meals first.");
    process.exit(1);
  }

  const weekStart = getWeekStart();

  if (planExists(plansDir, weekStart)) {
    const txtPath = path.join(plansDir, `week_${weekStart}.txt`);
    console.log(`Plan for week of ${weekStart} already exists.\n`);
    console.log(fs.readFileSync(txtPath, "utf-8"));
    return;
  }

  console.log(`Generating meal plan for week of ${weekStart}...`);
  const staples = JSON.parse(fs.readFileSync(staplesPath, "utf-8"));
  const plan = await generatePlan(staples, weekStart);
  const txtPath = savePlan(plansDir, plan);
  console.log(`Plan saved to ${txtPath}\n`);
  console.log(fs.readFileSync(txtPath, "utf-8"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
