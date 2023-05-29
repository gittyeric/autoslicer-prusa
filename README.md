# autoslicer-prusa

Never manually slice an STL again!  Upon saving your PrusaSlicer project file, generate all gcode permutations you care about and optionally auto-upload to all your printers. Example: update your model in 1 project file and autogenerate gcodes for many profiles like Printer1+PLA, Printer2+PLA, Printer1+PETG, Printer2+PETG.  This will also watch ALL your project files and global settings changes and instantly regenerate any affected gcode outputs and sync with printers.  Pretty much "hot reload" for fast design prototyping!  Hit save in PrusaSlicer and print any gcode version everywhere leveraging just your native PrusaSlicer settings.

## How it works

Given a projects folder that has some arbitrary structure, a mirror "gcode" folder will be generated that matches all your project files, but may contain extra gcode outputs suffixed with `"myProject/myPart-<Printer>-<Filament>-<PrintSettings>.gcode"`.  This script reads your PrusaSlicer's configuration directory automatically to generate all permutations of gcode you could ever care to generate, here's an example project folder:

```
<Root Project folder>
- myProject1
  - part1.3mf
  - part2.3mf
- myProject2
  - part1.3mf
  - part2.3mf
```

and would produce the following output structure:


```
<Root Project folder>
- gcode
  - myProject1
    - part1-myPrinter1-pla-custom1.gcode
    - part1-myPrinter2-pla-custom1.gcode
    - part1-myPrinter1-petg-custom1.gcode
    - part1-myPrinter2-petg-custom1.gcode
    - part1-myPrinter1-petg-custom2.gcode
    - part1-myPrinter2-petg-custom2.gcode
    ... (More excluded)
  - myProject2
    - part1-myPrinter1-pla-custom1.gcode
    - part1-myPrinter2-pla-custom1.gcode
    - part1-myPrinter1-petg-custom1.gcode
    - part1-myPrinter2-petg-custom1.gcode
    - part1-myPrinter1-petg-custom2.gcode
    - part1-myPrinter2-petg-custom2.gcode
    ... (More excluded)
```

Updating your .ini files will regenerate everything and updating a 3mf file only regenerates all gcodes for that part.

## Installing

This program requires Node.js (version 16 or higher) running on a Bash-like terminal.  Windows users can use a number of Bash-like emulators.

1. Clone this repository: `git clone https://github.com/gittyeric/autoslicer-prusa`

2. With Node.js (version 16 or up should do) and NPM installed, you can install by changing to this repo's directory and running:

`npm install`

3. You can now run with `npm --prusa=<my-prusaslicer-config-location> --project="<my-absolute-projects-folder-location>" start`

Where:

`<my-prusaslicer-config-location>` is the location PrusaSlicer takes you to when navigating to Help -> Show Configuration Folder.

`<my-absolute-projects-folder-location>` is the folder containing your PrusaSlicer .3mf project files (subfolders will also count).

If you see issues such as "Command not found: prusa-slicer", change `prusaSlicerCmd` in `index.ts` to whatever command works for your terminal (ex. `prusa-slicer-console` or `slic3r`).

## Running forever in Unix systems

The easiest way to install this program to run 24/7 and listen for file changes in a lightweight way is to add the script you are successfully running in step 3 to your crontab with:

`crontab -e`

Then add an entry to run autoslicer after every reboot:

`@reboot cd </path/to/>autoslicer-prusa && npm --prusa=<my-prusaslicer-config-location> --project="<my-absolute-projects-folder-location> start"`

## Adding new (Printer / Filament / Print Settings) combinations

This script will automatically track any changes or additions to your Printer, Filament or Print Settings profiles and regenerate all your project files accordingly.

```
Warning! Creating lots of .ini settings produces exponential permutations of gcodes per project file, so only keep the settings you really need in Prusaslicer and aggressively delete unused ones.
```

## Adding new 3mf project files

Simply add a new .3mf file anywhere in your projects folder and it will be immediately sliced against all `settings/` permutations and show up in the gcode/ folder.

## (Optional): "Live Reload" upload to printers

Simply save a PrusaSlicer project to auto-upload to all your printers!

Edit `index.ts` to include the list of SSH addresses to upload to (hint: you should use `ssh-copy-id` so your printer trusts your local Printer for SSH connections).  Whatever address(es) you use to access your printer(s) with ssh (ex. ssh `pi@myprinter.local`), add to the `rsyncUploadTargets` list.  Alternatively, you can specify a comma-separated `targets` argument on a per-command basis instead of modifying `config.ts`:

`npm --targets="pi@printer1.local,pi@10.10.10.10" --prusa=<my-prusaslicer-config-location> --project="<my-absolute-projects-folder-location>" start`


## Octoprint End-to-end Automation

If you use Octoprint or Linux to run your printer, you can also tie the gcode generation event to auto-upload the file to all your Octoprint bots using it's built-in folder watch feature.  By default, Octoprint checks for incoming gcode files (after [manually enabling this feature](https://community.octoprint.org/t/watched-folder-doesnt-run-as-well/14618/4)) at `/home/pi/.octoprint/watched`, so you can use the above section to configure appropriate targets such as `pi@10.10.10.10:/home/pi/.octoprint/watched`

Note that massive amounts of files will slow down Octoprint quite a bit with plugins like PrintGenius installed.