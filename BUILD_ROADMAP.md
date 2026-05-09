# Build Roadmap

This roadmap keeps us focused while the product grows from the current running-goal web prototype into a full mobile-first fitness forecasting app.

## Current App Status

Already working:

- Public Railway deployment
- Account signup and login
- Saved user data
- Manual run entry
- Running goal forecast
- Custom goal distance
- Optional target time
- Readiness score
- Weekly targets
- Basic charts

Current live app:

```text
https://half-marathon-forecaster-production.up.railway.app/
```

## Must Build Now

These are the next features that make the app feel like a real product foundation.

### 1. Better App Dashboard

Goal:

Make the first screen feel like a fitness command center, not a form.

Build:

- Current goal
- Readiness score
- Forecast date
- Credits balance
- Weekly streak
- Next workout target
- Recent activities

Why now:

Users should understand their progress within 5 seconds of opening the app.

### 2. User Profile

Goal:

Make forecasts and calorie estimates personal.

Build:

- Name
- Age
- Sex
- Height
- Weight
- Fitness level
- Primary goal
- Activity level

Why now:

Calories, recovery, and goal forecasts need personal context.

### 3. Unified Activity Model

Goal:

Prepare the app for running, HIIT, HYROX, strength, and bodybuilding.

Build:

- Activity type
- Date
- Duration
- Distance
- Calories
- Notes
- Source: manual or wearable
- Verified: yes/no

Why now:

If we add features before this, the data structure will get messy.

### 4. Calories V1

Goal:

Add the first version of calorie and protein guidance.

Build:

- Maintenance calorie estimate
- Weight-loss calorie target
- Weight-gain calorie target
- Protein target
- Estimated calories burned from workouts

Why now:

This is a major user hook, especially for the Indian market.

### 5. Credits V1

Goal:

Start the reward loop without real-money partner complexity.

Build:

- Credits balance
- Credits for logging workouts
- Credits for hitting weekly target
- Credits for streaks
- Credit history

Why now:

This makes the app habit-forming before we add brands or discounts.

## Build Soon

These come after the foundation is stable.

### 6. Strength Logging

Build:

- Exercise name
- Sets
- Reps
- Weight
- Workout templates
- Estimated 1RM
- Volume trend

### 7. Bodybuilding Insights

Build:

- Muscle group tracking
- Weekly volume by muscle
- Progressive overload suggestions
- Recovery warnings

### 8. Challenges V1

Build:

- Weekly distance challenge
- Workout streak challenge
- Calories/protein consistency challenge
- Credits for completing challenges

### 9. Goal History

Build:

- Past goals
- Completed goals
- Missed goals
- Forecast improvement over time

### 10. Better Mobile Layout

Build:

- Cleaner mobile dashboard
- Faster add-workout flow
- Bottom navigation pattern
- App-like screen structure

## Build Later

These are important, but they should not distract us too early.

### 11. Friends

Build:

- Add friend
- Friend activity feed
- Friend challenge invites

### 12. Leaderboards

Build:

- Friends leaderboard
- City leaderboard
- Challenge leaderboard
- Verified global leaderboard

Avoid early:

- One global leaderboard for everyone

Reason:

It becomes unfair fast and can reward extreme users over normal consistency.

### 13. Wearable Integrations

Start order:

1. Strava
2. Google Health Connect
3. Apple HealthKit
4. Fitbit
5. Garmin
6. Whoop
7. Samsung Health

Why later:

Each platform has different permissions, app review requirements, and data formats.

### 14. Real Rewards Marketplace

Build:

- Brand partner system
- Coupon inventory
- Redemption flow
- Anti-fraud checks
- Verified-credit rules

Why later:

This needs legal, business development, and fraud prevention.

### 15. Payments And Subscriptions

Build:

- Free plan
- Premium plan
- Advanced forecasts
- Advanced nutrition
- Advanced strength analytics
- Razorpay for India
- Stripe for global

## Mobile App Roadmap

The current web app is useful, but the real product should become a native-feeling mobile app.

Recommended stack:

- React Native
- Expo
- Expo Router
- Postgres backend
- Railway or Render hosting
- Supabase Auth or custom auth

First mobile screens:

- Onboarding
- Login/signup
- Home dashboard
- Add workout
- Goals
- Forecast
- Calories
- Credits
- Profile

## Recommended Immediate Sprint

Sprint 1 should focus on product foundation:

1. Add profile section.
2. Add dashboard section.
3. Add calories V1.
4. Add credits V1.
5. Update saved user state to support these fields.

Success criteria:

- A user can create an account.
- A user can enter their body stats.
- A user can see a calorie/protein target.
- A user can log workouts.
- A user earns credits from activity.
- The home screen shows their goal, score, streak, and next target.

## Product Rule

Every feature should answer one of these questions:

- What is my goal?
- Where am I today?
- When can I get there?
- What should I do next?
- What reward did I earn for showing up?

If a feature does not answer one of those, it should wait.
