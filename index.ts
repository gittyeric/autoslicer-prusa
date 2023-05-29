import watch from "node-watch";
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';

// The terminal / command line program to invoke for slicing, ex. 'prusa-slicer-console'
export const prusaSlicerCmd: string = 'prusa-slicer';

// Add any targets that your machine can successfully access with ssh, followed by :<absolute-remote-folder-location>
// Can also merge in per-run targets as script inputs, see README.md
export const rsyncUploadTargets: string[] = [
    //'pi@myprinter.local:/home/pi/.octoprint/watched',
    //'pi@10.10.10.10:/home/pi/.octoprint/watched',
];

type Settings = {
    prusaFolder: string,
    printers: string[],
    filaments: string[],
    printSettings: string[],
}

type GcodeMeta = {
    file: string,
    projectSrc: string,
    settings: [string, string, string],
}

let generateAllLock: Promise<unknown> = Promise.resolve(0);
let generateAllRequestCount = 0;
let generateAllCompleteCount = 0;

function* walk3mfSync(dir: string): Generator<string, undefined, undefined> {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        if (file.isDirectory()) {
            yield* walk3mfSync(path.join(dir, file.name));
        } else {
            const fullFile = path.join(dir, file.name);
            if (fullFile.endsWith('.3mf')) {
                yield fullFile;
            }
        }
    }
    return undefined;
}

function* walkGcodesSync(gcodeDir: string) {
    const files = fs.readdirSync(gcodeDir, { withFileTypes: true });
    for (const file of files) {
        if (file.isDirectory()) {
            yield* walk3mfSync(path.join(gcodeDir, file.name));
        } else {
            const fullFile = path.join(gcodeDir, file.name);
            if (fullFile.endsWith('.gcode')) {
                yield fullFile;
            }
        }
    }
}

function getSettings(prusaFolder: string): Settings {
    const printers = fs.readdirSync(prusaFolder + '/printer', { withFileTypes: true }).filter((f) => f.name.endsWith('.ini')).map((f) => f.name.replace(/\.ini/g, ''));
    const filaments = fs.readdirSync(prusaFolder + '/filament', { withFileTypes: true }).filter((f) => f.name.endsWith('.ini')).map((f) => f.name.replace(/\.ini/g, ''));
    const printSettings = fs.readdirSync(prusaFolder + '/print', { withFileTypes: true }).filter((f) => f.name.endsWith('.ini')).map((f) => f.name.replace(/\.ini/g, ''));

    return { prusaFolder, printers, filaments, printSettings };
}

async function execLogError(cmd: string, args: string[]) {
    try {
        console.info('autoslice: ' + cmd + ' ' + args.join(' '));
        const res = await execa(cmd, args);
        if (res.stdout.trim().length > 0) {
            console.info('autoslice: ' + res.stdout);
        }
    } catch (e) {
        console.error('autoslice: ' + JSON.stringify(e, null, 2));
    }
}

function generateCmd(settings: Settings, gcodeMeta: GcodeMeta) {
    let args = ['-o', gcodeMeta.file, '-g', gcodeMeta.projectSrc];
    for (let i = 0; i < gcodeMeta.settings.length; i++) {
        const setting = gcodeMeta.settings[i];
        if (setting !== '_') {
            const folder = i === 0 ? 'printer' : (i === 1 ? 'filament' : 'print');
            args.push(...['--load', `${settings.prusaFolder}/${folder}/${setting}.ini`]);
        }
    }

    return execLogError(prusaSlicerCmd, args);
}

function findAllGcodePermutations(projectsFolder: string, settings: Settings, file3mf: string): GcodeMeta[] {
    const metas: GcodeMeta[] = [];
    // Generate all the cmds to run to generate all the permutations this file needs
    // First, generate the vanilla project file as-is
    const baseGcodeFile = file3mf.replace(/3mf$/g, 'gcode').replace(projectsFolder, projectsFolder + '/gcode');
    metas.push({
        file: baseGcodeFile,
        projectSrc: file3mf,
        settings: ['_', '_', '_'],
    });

    // Now all the explicit permutations
    const level1Settings = settings.printers || ['_'];
    const level2Settings = settings.filaments || ['_'];
    const level3Settings = settings.printSettings || ['_'];

    for (const level1 of level1Settings) {
        for (const level2 of level2Settings) {
            for (const level3 of level3Settings) {
                if (level1 === '_' && level2 === '_' && level3 === '_') {
                    continue;
                }
                metas.push({
                    file: baseGcodeFile.replace(/\.gcode$/g, `_${level1}-${level2}-${level3}.gcode`),
                    projectSrc: file3mf,
                    settings: [level1, level2, level3],
                });
            }
        }
    }

    return metas;
}

async function generateAllForProject(projectsFolder: string, settings: Settings, file3mf: string) {
    console.info('autoslice: ' + `Slicing ${file3mf}`);
    const gcodeMetas = findAllGcodePermutations(projectsFolder, settings, file3mf);
    const pendingSlices = gcodeMetas.map(async (gcodeMeta) => {
        // Ensure directory exists recursively
        fs.mkdirSync(path.dirname(gcodeMeta.file), { recursive: true });
        return generateCmd(settings, gcodeMeta);
    });
    try {
        await Promise.all(pendingSlices);
    } catch (e) {
        console.error('autoslice: ' + JSON.stringify(e));
    }

    return gcodeMetas;
}

function _deleteAllGcodes(gcodeFolder: string) {
    if (fs.existsSync(gcodeFolder)) {
        console.warn('autoslice: ' + `Deleting all gcode in ${gcodeFolder}`);
        fs.rmSync(gcodeFolder, { recursive: true, force: true });
        fs.mkdirSync(gcodeFolder);
        return true;
    }
    return false;
}

// Destroy and re-create the entire projectsFolder, guaranteed to only run 1 at a time
async function generateAll(projectsFolder: string, settings: Settings, skipDelete: boolean = false) {
    // Don't even bother if too many pending requests to regenerate all
    if (generateAllRequestCount - 1 > generateAllCompleteCount) {
        console.warn('Throttling nuclear regenerate and upload');
        return;
    }

    generateAllRequestCount++;
    // Ensure generateAll can only be called once at a time!
    generateAllLock = generateAllLock.then(() => {
        return new Promise(async (res) => {
            if (!skipDelete) {
                _deleteAllGcodes(projectsFolder + '/gcode');
            }
            // Walk all files that end with .3mf
            const projectFiles = walk3mfSync(projectsFolder);
            for (const projectFile of projectFiles) {
                await generateAllForProject(projectsFolder, settings, projectFile);
            }
            generateAllCompleteCount++;
            // Ensure rsynced only after all chained regens are done
            if (generateAllCompleteCount === generateAllRequestCount) {
                await triggerRsyncUploads(projectsFolder + '/gcode');
            }
            res(undefined);
        });
    });
}

// Leave the smarts of diff tracking to rsync and just bulk rsync
// all generated gcode to all rsync targets
async function triggerRsyncUploads(gcodeFolder: string) {
    let count = 0;
    const pendingUploads = rsyncUploadTargets.map(async (target) => {
        const targetWrite = execLogError('rsync', ['-r', '-t', '--delete', gcodeFolder + '/', target]);
        targetWrite.then(() => { console.info(`autoslice: Done re-syncing with ` + target) });
        count++;
        // Wait for the rsync write every X concurrent runs
        if (count % 10 === 0) {
            await targetWrite;
        }
        return targetWrite;
    });
    try {
        await Promise.all(pendingUploads);
    } catch (e) {
        console.error('autoslice: ' + JSON.stringify(e));
    }
}

async function triggerRsyncUpload(projectsFolder, gcodeFile: string) {
    const destFolder = path.dirname(gcodeFile).replace(projectsFolder + '/gcode', '');
    const pendingUploads = rsyncUploadTargets.map(async (target) => {
        const targetWrite = execLogError('rsync', [gcodeFile, (target + destFolder).replace('//', '/')]);
        return targetWrite;
    });
    try {
        await Promise.all(pendingUploads);
    } catch (e) {
        console.error('autoslice: ' + JSON.stringify(e));
    }
}

function findStaleGcodes(settings: Settings, projectsFolder: string, updatedProjectFile: string): string[] {
    const updatedDir = path.dirname(updatedProjectFile);
    const projectName = path.basename(updatedProjectFile).replace(/.3mf$/g, '');
    const updatedGcodeDir = updatedDir.replace(projectsFolder, projectsFolder + '/gcode');

    // If gcode dir doesn't event exist yet, no stale files
    if (!fs.existsSync(updatedGcodeDir)) {
        return [];
    }
    const gcodeFiles = fs.readdirSync(updatedGcodeDir, { withFileTypes: true });
    const regex = new RegExp(`${projectName}_.*\-.*\-.*.gcode`);
    return gcodeFiles.filter((gf) => {
        gf.isFile() && (regex.test(gf.name) || gf.name === `${projectName}.gcode`)
    }).map((gf) => path.join(gf.path, gf.name));
}

function watchProjectsDir(projectsFolder: string, prusaFolder: string): void {
    const watcher = watch.default(projectsFolder, {
        recursive: true,
        delay: 250,
        filter(file, skip) {
            return file.endsWith('.3mf');
        },
    }, async function (evt, updatedFilename) {
        const settings = getSettings(prusaFolder);
        // Unconditionally delete stale gcode files
        const staleFiles = findStaleGcodes(settings, projectsFolder, updatedFilename);
        for (const stale of staleFiles) {
            console.info('autoslice: ' + `Deleting stale ${stale}`);
            fs.unlinkSync(stale);
        }
        if (evt === 'update') {
            // If project file updated/added, regenerate
            const gcodeFiles = (await generateAllForProject(projectsFolder, settings, updatedFilename)).map((g) => g.file);
            for (const gcodeFile of gcodeFiles) {
                triggerRsyncUpload(projectsFolder, gcodeFile);
            }
        }
    });
    console.info('autoslice: ' + `Listening for .3mf files in ${projectsFolder}`);
}

function watchSettingsDir(projectsFolder: string, prusaFolder: string): void {
    const watcher = watch.default(prusaFolder, {
        recursive: true,
        delay: 250,
        filter(file, skip) {
            return file.endsWith('.ini');
        },
    }, async function (evt, updatedFilename) {
        if (updatedFilename.startsWith(prusaFolder + '/printer/') ||
            updatedFilename.startsWith(prusaFolder + '/print/') ||
            updatedFilename.startsWith(prusaFolder + '/filament/')) {
            console.info('autoslice: ' + `Regenerating all in response to ${updatedFilename} changing`);
            const settings = getSettings(prusaFolder);
            // Delete all and regenerate some if global settings changed at all
            await generateAll(projectsFolder, settings);
        }
    });
    console.info('autoslice: ' + `Listening for .ini files in ${prusaFolder}`);
}

// Entrypoint
(async () => {
    const rawProjectsFolder = process.env.npm_config_project as string;
    const projectsFolder = rawProjectsFolder.endsWith('/') ? rawProjectsFolder.substring(0, rawProjectsFolder.length - 1) : rawProjectsFolder;
    if (!fs.existsSync(projectsFolder)) {
        console.error('autoslice: ' + `Could not find project directory ${projectsFolder}, please specify project folder like: 'npm --project="<absolute-path-to-projects>" start'`);
        process.exit(-1);
    }

    // Ensure gcode output dir exists
    const gcodeFolder = projectsFolder + '/gcode';
    const gcodeWasInitialized = fs.existsSync(gcodeFolder);
    if (!gcodeWasInitialized) {
        fs.mkdirSync(gcodeFolder);
    }

    // Ensure all settings folders are good
    const rawPrusaFolder = process.env.npm_config_prusa as string;
    const prusaFolder = rawPrusaFolder.endsWith('/') ? rawPrusaFolder.substring(0, rawPrusaFolder.length - 1) : rawPrusaFolder;
    if (!fs.existsSync(prusaFolder)) {
        console.error('autoslice: ' + `Could not find PrusaSlicer directory ${prusaFolder}, please check permissions or specify project folder like: 'npm --prusa="<absolute-path-to-Prusa/.config/PrusaSlicer-beta>" start'`);
        process.exit(-1);
    }
    if (!fs.existsSync(prusaFolder + '/printer')) {
        console.error('autoslice: ' + `Expected a printer/ directory in ${prusaFolder}, wrong directory?`);
        process.exit(-1);
    }
    if (!fs.existsSync(prusaFolder + '/print')) {
        console.error('autoslice: ' + `Expected a print/ directory in ${prusaFolder}`);
        process.exit(-1);
    }
    if (!fs.existsSync(prusaFolder + '/filament')) {
        console.error('autoslice: ' + `Expected a filament/ directory in ${prusaFolder}`);
        process.exit(-1);
    }

    // Optional per-run upload targets are merged with the same list from config.ts
    const rawTargets = process.env.npm_config_targets;
    const targets = rawTargets ? rawTargets.split(',') : [];
    if (targets.length > 0) {
        rsyncUploadTargets.push(...targets);
        console.info('autoslice: ' + `Using upload targets: ${JSON.stringify(rsyncUploadTargets, null, 2)}`);
    }

    const settings = getSettings(prusaFolder);
    console.info('autoslice: ' + `Loaded settings combinations: ${JSON.stringify(settings, null, 2)}`);

    // Listen to changes forever
    watchProjectsDir(projectsFolder, prusaFolder);
    watchSettingsDir(projectsFolder, prusaFolder);

    // Bootstrap with a mass upload if not already run
    if (!gcodeWasInitialized) {
        await generateAll(projectsFolder, settings);
    } else {
        console.info(`Resuming from last run, to force a mass re-generate + upload, delete ${gcodeFolder} and re-run or change a profile in Prusaslicer`);
    }
})();
