#!/usr/bin/env python3
"""Weekly Meal Planner — generates a 7-day lunch and dinner plan for 2 people."""

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import anthropic
from pydantic import BaseModel


class Meal(BaseModel):
    name: str
    description: str
    protein_g_per_person: int
    calories_per_person: int
    prep_time_minutes: int
    ingredients: list[str]


class DayPlan(BaseModel):
    day: str
    lunch: Meal
    dinner: Meal


class GrocerySection(BaseModel):
    section: str
    items: list[str]


class WeeklyMealPlan(BaseModel):
    week_of: str
    variety_note: str
    days: list[DayPlan]
    grocery_list: list[GrocerySection]


def get_week_start() -> str:
    today = datetime.now()
    monday = today - timedelta(days=today.weekday())
    return monday.strftime("%Y-%m-%d")


def plan_exists(plans_dir: Path, week_start: str) -> bool:
    return (plans_dir / f"week_{week_start}.txt").exists()


def load_staples(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def extract_json(text: str) -> str:
    """Strip markdown code blocks if present."""
    text = text.strip()
    if "```json" in text:
        text = text.split("```json", 1)[1]
        text = text.rsplit("```", 1)[0]
    elif "```" in text:
        text = text.split("```", 1)[1]
        text = text.rsplit("```", 1)[0]
    return text.strip()


def make_client() -> anthropic.Anthropic:
    import os
    auth_token = os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if auth_token:
        return anthropic.Anthropic(auth_token=auth_token)
    return anthropic.Anthropic()  # falls back to ANTHROPIC_API_KEY


def generate_plan(staples: dict, week_start: str) -> WeeklyMealPlan:
    client = make_client()

    system = f"""You are a personal meal planner for a couple: Steph and her partner.

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
{json.dumps(staples, indent=2)}

GROCERY LIST RULES:
- Consolidate all ingredients across the full week (don't list chicken 7 times)
- Include exact quantities for 2 people for the entire week
- Organize into exactly these sections: Produce, Meat & Fish, Dairy & Eggs, Pantry, Frozen
- Use preferred brands from the staples list where specified
- Do NOT include pantry_staples.always_on_hand or pantry_staples.fridge_staples items

OUTPUT: Return ONLY valid JSON. No markdown, no explanation, no preamble."""

    user_message = f"""Plan meals for the week of {week_start} (Monday through Sunday).

Return this exact JSON structure:
{{
  "week_of": "{week_start}",
  "variety_note": "One sentence describing what's new or varied this week",
  "days": [
    {{
      "day": "Monday",
      "lunch": {{
        "name": "Meal Name",
        "description": "Brief appetizing description",
        "protein_g_per_person": 45,
        "calories_per_person": 520,
        "prep_time_minutes": 20,
        "ingredients": ["ingredient with quantity for 2 people", "..."]
      }},
      "dinner": {{ "name": "...", "description": "...", "protein_g_per_person": 75, "calories_per_person": 750, "prep_time_minutes": 25, "ingredients": ["..."] }}
    }}
  ],
  "grocery_list": [
    {{ "section": "Produce", "items": ["3 heads broccoli", "..."] }},
    {{ "section": "Meat & Fish", "items": ["..."] }},
    {{ "section": "Dairy & Eggs", "items": ["..."] }},
    {{ "section": "Pantry", "items": ["..."] }},
    {{ "section": "Frozen", "items": ["..."] }}
  ]
}}

Include all 7 days (Monday through Sunday)."""

    print("  Calling Claude...", flush=True)

    response = client.messages.create(
        model="claude-opus-4-7",
        max_tokens=8192,
        thinking={"type": "adaptive"},
        system=system,
        messages=[{"role": "user", "content": user_message}],
    )

    text = next(b.text for b in response.content if b.type == "text")
    json_str = extract_json(text)

    try:
        return WeeklyMealPlan.model_validate_json(json_str)
    except Exception as e:
        print(f"\nFailed to parse meal plan: {e}", file=sys.stderr)
        print("Raw response:", file=sys.stderr)
        print(json_str[:500], file=sys.stderr)
        raise


def format_plan(plan: WeeklyMealPlan) -> str:
    width = 58
    border = "=" * width
    thin = "-" * width

    try:
        dt = datetime.strptime(plan.week_of, "%Y-%m-%d")
        week_label = dt.strftime("%B %-d, %Y")
    except Exception:
        week_label = plan.week_of

    lines = [
        border,
        f"  WEEKLY MEAL PLAN  |  Week of {week_label}",
        border,
        "",
        f"  {plan.variety_note}",
        "",
    ]

    for day in plan.days:
        lunch = day.lunch
        dinner = day.dinner
        day_cal = lunch.calories_per_person + dinner.calories_per_person
        day_pro = lunch.protein_g_per_person + dinner.protein_g_per_person

        lines += [
            thin,
            f"  {day.day.upper()}  |  {day_cal:,} cal  |  {day_pro}g protein",
            thin,
            "",
            f"  LUNCH  [{lunch.prep_time_minutes} min]  {lunch.calories_per_person} cal  |  {lunch.protein_g_per_person}g protein",
            f"  {lunch.name}",
            f"  {lunch.description}",
            "",
            f"  DINNER  [{dinner.prep_time_minutes} min]  {dinner.calories_per_person} cal  |  {dinner.protein_g_per_person}g protein",
            f"  {dinner.name}",
            f"  {dinner.description}",
            "",
        ]

    lines += [border, "  GROCERY LIST", border, ""]

    for section in plan.grocery_list:
        if section.items:
            lines.append(f"  {section.section.upper()}")
            for item in section.items:
                lines.append(f"    - {item}")
            lines.append("")

    return "\n".join(lines)


def save_plan(plans_dir: Path, plan: WeeklyMealPlan) -> tuple[Path, Path]:
    plans_dir.mkdir(exist_ok=True)
    base = plans_dir / f"week_{plan.week_of}"
    json_path = base.with_suffix(".json")
    txt_path = base.with_suffix(".txt")
    json_path.write_text(json.dumps(plan.model_dump(), indent=2))
    txt_path.write_text(format_plan(plan))
    return json_path, txt_path


def main() -> None:
    base_dir = Path(__file__).parent
    staples_path = base_dir / "staples.json"
    plans_dir = base_dir / "plans"

    if not staples_path.exists():
        print(f"Error: staples.json not found at {staples_path}")
        print("Edit staples.json with your regular foods and meals first.")
        sys.exit(1)

    week_start = get_week_start()

    if plan_exists(plans_dir, week_start):
        txt_path = plans_dir / f"week_{week_start}.txt"
        print(f"Plan for week of {week_start} already exists.\n")
        print(txt_path.read_text())
        return

    print(f"Generating meal plan for week of {week_start}...")
    staples = load_staples(staples_path)
    plan = generate_plan(staples, week_start)
    json_path, txt_path = save_plan(plans_dir, plan)
    print(f"Plan saved to {txt_path}\n")
    print(txt_path.read_text())


if __name__ == "__main__":
    main()
