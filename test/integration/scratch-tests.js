/* global vm, Promise */
const {Chromeless} = require('chromeless');
const test = require('tap').test;
const path = require('path');
const fs = require('fs');
const chromeless = new Chromeless();

const testFile = (file) => {
    const fullPath = path.resolve(__dirname, 'scratch-tests', file);
    return test(file, async function run (t) {
        const result = await chromeless
            .goto(`file://${path.resolve(__dirname, 'index.html')}`)
            .setFileInput('#file', fullPath)
            .wait('#loaded')
            .evaluate(() => {
                const says = [];

                vm.runtime.on('SAY', (_, __, message) => {
                    says.push(message);
                });

                vm.greenFlag();

                return Promise.resolve()
                    .then(async () => {
                        while (vm.runtime.threads.length > 0) {
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }

                        return says;
                    });
            });

        // Map string messages to tap reporting methods. This will be used
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
        const reportVmResult = text => {
            const command = text.split(/\s+/, 1)[0].toLowerCase();
            if (reporters[command]) {
                return reporters[command](text.substring(command.length).trim());
            }

            // Default to a comment with the full text if we didn't match
            // any command prefix
            return reporters.comment(text);
        };

        result.forEach(reportVmResult);
        if (!didPlan) {
            t.comment('did not say "plan NUMBER_OF_TESTS"');
        }

        // End must be called so that tap knows the test is done. If
        // the test has an SAY "end" block but that block did not
        // execute, this explicit failure will raise that issue so
        // it can be resolved.
        if (!didEnd) {
            t.fail('did not say "end"');
            t.end();
        }
    });
};

(async () => {
    const files = fs.readdirSync(path.resolve(__dirname, 'scratch-tests'))
        .filter(uri => uri.endsWith('.sb2') || uri.endsWidth('.sb3'));
    for (const file of files) {
        await testFile(file);
    }

    await chromeless.end();
})();
