/* global vm, render, renderCpu, canvas, document */
const {chromium} = require('playwright-chromium');
const test = require('tap').test;
const path = require('path');
const fs = require('fs');

const indexHTML = path.resolve(__dirname, 'index.html');
const testDir = (...args) => path.resolve(__dirname, 'diff-tests', ...args);

const testFile = (file, page) => test(file, async t => {
    // start each test by going to the index.html, and loading the scratch file
    await page.goto(`file://${indexHTML}`);
    const fileInput = await page.$('#file');
    await fileInput.setInputFiles(testDir(file));
    await page.evaluate(() =>
        // `loadFile` is defined on the page itself.
        // eslint-disable-next-line no-undef
        loadFile()
    );
    const msgsFromBrowser = await page.evaluate(() => {
        // This function is run INSIDE the integration chrome browser via some
        // injection and .toString() magic.  We can return some "simple data"
        // back across as a promise, so we will just log all the says that happen
        // for parsing after.

        const drawDiffImage = (left, right) => {
            const leftCanvas = left.canvas;
            const rightCanvas = right.canvas;

            const {width, height} = leftCanvas;
            if (rightCanvas.width !== width || rightCanvas.height !== height) {
                throw new Error('canvases to be diffed have different dimensions');
            }

            // room at the top to draw text labels
            const TOP_PADDING = 20;
            const diffCanvas = document.createElement('canvas');
            diffCanvas.width = width * 3;
            diffCanvas.height = height + TOP_PADDING;

            const diffCtx = diffCanvas.getContext('2d');

            diffCtx.fillStyle = 'black';
            diffCtx.fillRect(0, 0, diffCanvas.width, TOP_PADDING);

            diffCtx.globalCompositeOperation = 'difference';
            diffCtx.fillStyle = 'white';
            diffCtx.fillRect(width, 0, width, TOP_PADDING);
            diffCtx.font = '16px sans-serif';
            diffCtx.fillText(left.label, 10, TOP_PADDING - 4);
            diffCtx.fillText('Diff', width + 10, TOP_PADDING - 4);
            diffCtx.fillText(right.label, (width * 2) + 10, TOP_PADDING - 4);

            diffCtx.globalCompositeOperation = 'source-over';
            diffCtx.drawImage(leftCanvas, 0, TOP_PADDING);
            diffCtx.drawImage(rightCanvas, width * 2, TOP_PADDING);

            diffCtx.globalCompositeOperation = 'difference';
            diffCtx.drawImage(leftCanvas, width, TOP_PADDING);
            diffCtx.drawImage(rightCanvas, width, TOP_PADDING);

            return diffCanvas.toDataURL();
        };

        const testCpuDiff = cpuData => {
            // Get the image data from the GPU-rendered canvas
            const [width, height] = render.getNativeSize();
            if (canvas.width !== width || canvas.height !== height) {
                throw new Error('GPU canvas dimensions do not match "native" size');
            }
            render.draw();

            // The renderer canvas has a WebGL context so we can't directly call getImageData on it.
            // Instead, draw it onto another canvas then call getImageData on *that* canvas.
            const mergeCanvas = document.createElement('canvas');
            mergeCanvas.width = width;
            mergeCanvas.height = height;
            const mergeCtx = mergeCanvas.getContext('2d');
            mergeCtx.drawImage(canvas, 0, 0);

            const gpuData = mergeCtx.getImageData(0, 0, width, height);

            let error = 0;
            for (let i = 0; i < cpuData.data.length; i++) {
                error += Math.abs(cpuData.data[i] - gpuData.data[i]);
            }

            // Average out the error across the three color channels
            error /= 3;

            // Normalize so 1 = completely different, 0 = exactly the same
            error /= 255;

            return {
                error,
                errorPercentage: 100 * (error / (width * height)),
                cpuData
            };
        };

        // this becomes `msgsFromBrowser` in the outer scope
        const messages = [];
        const TIMEOUT = 5000;

        vm.runtime.on('SAY', (_, __, message) => {
            const messageSplit = message.split(' ');
            if (messageSplit.length < 1) throw new Error(`Could not parse say bubble '${message}'`);

            if (messageSplit[0] === 'cpu-gpu-difference') {
                const cpuData = renderCpu(render);
                const {error, errorPercentage} = testCpuDiff(cpuData);

                // Support both percentage errors ('0.1%') and error in pixels ('10px')
                const expectedErrorString = messageSplit[1];
                let actualErrorString;
                let expectedErrorValue;
                let actualErrorValue;
                if (messageSplit[1].endsWith('%')) {
                    actualErrorString = `${errorPercentage.toFixed(4)}%`;
                    expectedErrorValue = Number(messageSplit[1].slice(0, -1));
                    actualErrorValue = errorPercentage;
                } else if (messageSplit[1].endsWith('px')) {
                    actualErrorString = `${error}px`;
                    expectedErrorValue = Number(messageSplit[1].slice(0, -2));
                    actualErrorValue = error;
                } else {
                    throw new Error(`Can't measure error in ${messageSplit[1]}`);
                }

                const failed = actualErrorValue > expectedErrorValue;

                let diffImage;
                if (failed) {
                    // Calculate a visual diff
                    const cpuDataCanvas = document.createElement('canvas');
                    cpuDataCanvas.width = cpuData.width;
                    cpuDataCanvas.height = cpuData.height;
                    cpuDataCanvas.getContext('2d').putImageData(cpuData, 0, 0);

                    diffImage = drawDiffImage(
                        {canvas, label: 'GPU'},
                        {canvas: cpuDataCanvas, label: 'CPU'}
                    );
                }

                messages.push({
                    command: actualErrorValue > expectedErrorValue ? 'fail' : 'pass',
                    text: failed ?
                        `total error was ${actualErrorString}, exceeding maximum allowed (${expectedErrorString})` :
                        `error did not exceed ${expectedErrorString}`,
                    error,
                    diffImage
                });
            }
        });

        vm.greenFlag();
        const startTime = Date.now();

        return Promise.resolve()
            .then(async () => {
                // waiting for all threads to complete, then we return
                while (vm.runtime.threads.some(thread => vm.runtime.isActiveThread(thread))) {
                    if ((Date.now() - startTime) >= TIMEOUT) {
                        // if we push the message after end, the failure from tap is not very useful:
                        // "not ok test after end() was called"
                        messages.unshift({
                            command: 'fail',
                            text: `Threads still running after ${TIMEOUT}ms`
                        });
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                return messages;
            });
    });

    // Map messages to tap reporting methods. This will be used
    // with events from scratch's runtime emitted on block instructions.
    let didPlan = false;
    let didEnd = false;
    const reporters = {
        comment (message) {
            t.comment(message);
        },
        pass (reason) {
            t.pass(reason);
        },
        fail (reason) {
            t.fail(reason);
        },
        plan (count) {
            didPlan = true;
            t.plan(Number(count));
        },
        end () {
            didEnd = true;
            t.end();
        }
    };

    // loop over each message passed back from the browser
    msgsFromBrowser.forEach((message, index) => {
        const {command, text} = message;

        // Write the diff image into the "fails" folder to allow for visual inspection
        if (command === 'fail' && 'diffImage' in message) {
            const pngData = message.diffImage.replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(
                testDir('fails', `${file.replace(/\.sb3$/, '')}-${index}.png`),
                pngData,
                {encoding: 'base64'}
            );
        }

        if (reporters[command]) {
            return reporters[command](text);
        }

        // Default to a comment with the full text if we didn't match
        // any command prefix
        return reporters.comment(text);
    });

    if (!didPlan) {
        t.comment('did not say "plan NUMBER_OF_TESTS"');
    }

    // End must be called so that tap knows the test is done. If
    // the test has a SAY "end" block but that block did not
    // execute, this explicit failure will raise that issue so
    // it can be resolved.
    if (!didEnd) {
        // t.fail('did not say "end"');
        t.end();
    }
});

// immediately invoked async function to let us wait for each test to finish before starting the next.
(async () => {
    const browser = await chromium.launch({headless: false});
    const page = await browser.newPage();

    const files = fs.readdirSync(testDir())
        .filter(uri => uri.endsWith('.sb2') || uri.endsWith('.sb3'));

    for (const file of files) {
        await testFile(file, page);
    }

    // close the browser window we used
    await browser.close();
})();
