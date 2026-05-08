#!/usr/bin/env hise-cli run
# Page Switcher — two buttons in a radio group toggle visibility of two panels.

# 1. Ensure HISE is running
/hise
launch
/expect status project is hise_project or abort
/exit

# 2. Start fresh
/builder
reset
/exit

# 3. Create UI components — two buttons (top bar) and two panels (content area)
/ui
add ScriptButton as "Page1Btn"
add ScriptButton as "Page2Btn"
set Page1Btn.bounds [0, 0, 300, 40]
set Page2Btn.bounds [300, 0, 300, 40]
# saveInPreset false: without this, preset restoration after /compile
# resets setValue(1) from onInit back to 0, breaking initial state.
set Page1Btn.radioGroup 1, Page1Btn.saveInPreset false
set Page2Btn.radioGroup 1, Page2Btn.saveInPreset false
add ScriptPanel as "Page1"
add ScriptPanel as "Page2"
set Page1.bounds [0, 40, 600, 460]
set Page2.bounds [0, 40, 600, 460]
/exit

# 4. Set up radio group and page switching logic
/script
/callback onInit
Content.makeFrontInterface(600, 500);

const var page1Btn = Content.getComponent("Page1Btn");
const var page2Btn = Content.getComponent("Page2Btn");
const var page1 = Content.getComponent("Page1");
const var page2 = Content.getComponent("Page2");

// Page switching callbacks
inline function onPage1Click(component, value)
{
    page1.showControl(value);
    page2.showControl(1 - value);
}

inline function onPage2Click(component, value)
{
    page2.showControl(value);
    page1.showControl(1 - value);
}

page1Btn.setControlCallback(onPage1Click);
page2Btn.setControlCallback(onPage2Click);

// Initial state: Page1 active, Page2 hidden
page1Btn.setValue(1);
page1.showControl(1);
page2.showControl(0);

/compile
/exit

# 5. Test state transitions via sequence
/sequence
create "page_test"

# Check initial state (Page1 active)
0ms eval page1Btn.getValue() as INIT_BTN1
0ms eval page2Btn.getValue() as INIT_BTN2
0ms eval page1.get("visible") as INIT_PAGE1
0ms eval page2.get("visible") as INIT_PAGE2

# Switch to Page2 at 100ms
100ms set Interface.Page2Btn 1

# Check state after switching to Page2
150ms eval page1Btn.getValue() as AFTER2_BTN1
150ms eval page2Btn.getValue() as AFTER2_BTN2
150ms eval page1.get("visible") as AFTER2_PAGE1
150ms eval page2.get("visible") as AFTER2_PAGE2

# Switch back to Page1 at 300ms
300ms set Interface.Page1Btn 1

# Check state after switching back to Page1
350ms eval page1Btn.getValue() as BACK_BTN1
350ms eval page2Btn.getValue() as BACK_BTN2
350ms eval page1.get("visible") as BACK_PAGE1
350ms eval page2.get("visible") as BACK_PAGE2

flush
play "page_test"

# Verify initial state
/expect get INIT_BTN1 is 1
/expect get INIT_BTN2 is 0
/expect get INIT_PAGE1 is true
/expect get INIT_PAGE2 is false

# Verify after clicking Page2
/expect get AFTER2_BTN1 is 0
/expect get AFTER2_BTN2 is 1
/expect get AFTER2_PAGE1 is false
/expect get AFTER2_PAGE2 is true

# Verify after clicking back to Page1
/expect get BACK_BTN1 is 1
/expect get BACK_BTN2 is 0
/expect get BACK_PAGE1 is true
/expect get BACK_PAGE2 is false

/exit