# HalfHour — test report

**Run date:** 25 October 2026  
**Result:** 27 automated browser checks passed across three test passes. No JavaScript runtime exceptions were observed in those passes.

## Passed checks

### Core interactions (13)

1. The Day screen creates exactly 48 half-hour slots in 24 hourly groups, with two stacked slots per group.
2. A one-off label and custom colour save correctly.
3. Activity label, custom colour, and manual `Done` status persist after reload.
4. Different dates retain separate schedules.
5. Preserve-clock-times mode moves an activity into the matching real-world time slot.
6. Shift mode keeps slot order while moving the timeline start.
7. A reusable Action can be created.
8. Deleting an Action keeps its currently displayed slot label and colour.
9. Four starter Templates are available.
10. Editing a date after applying a Template does not edit the source Template.
11. The dark theme preference survives reload.
12. Service-worker cache contains the required app-shell files.
13. At a 390 px viewport, the page itself has no horizontal overflow; horizontal scrolling is contained within the timeline.

### Time boundaries, offline and backups (8)

14. Cancelling a start-time change leaves the schedule untouched.
15. A midnight start produces the correct 12 AM first slot and 11:30 PM–12 AM final slot.
16. An 11 PM start retains the correct 7 AM activity position when preserving clock times and calculates the final slot correctly.
17. Shift mode also works when changing a start time at the midnight boundary.
18. With network access emulated as offline after caching, the app reloads from the cached shell and IndexedDB data remains available.
19. Backup export downloads a syntactically valid JSON file with the expected application/schema fields.
20. Invalid JSON import is rejected and existing schedule data remains unchanged.
21. A valid exported backup can be re-imported and restores the saved schedule after confirmation.

### Actions and Templates management (6 grouped checks)

22. Changing an Action's default label/colour updates inheriting slots but not slot-level label/colour overrides.
23. Deleting that updated Action preserves labels and colours on both types of slot.
24. Duplicating a Template copies its slot schedule.
25. Renaming a Template succeeds.
26. Deleting a Template keeps an applied, independently edited date schedule and clears its template association.
27. The reset confirmation restores the seven starter Actions and four starter Templates and clears saved date schedules.

## Environment and unverified items

- Tested with automated DevTools control in headless Chromium, including a 390 × 844 CSS-pixel mobile viewport.
- The offline test was performed after the service worker had installed and cached the app shell.
- These tests are not a substitute for opening the app in Safari on the actual iPhone. Real-device Home Screen installation, Safari-specific rendering, file export/import user experience, and offline launch should be verified after hosting.
- No public deployment URL was created, and the app was not installed on the user's device.
