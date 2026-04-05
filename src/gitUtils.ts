import * as cp from 'child_process';

export function execGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr.trim() || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

export function isOverleafRepo(remoteUrl: string): boolean {
    return remoteUrl.includes('git.overleaf.com') || remoteUrl.includes('overleaf.com');
}

export async function getRemoteUrl(repoPath: string): Promise<string | undefined> {
    try {
        const url = (await execGit(repoPath, ['remote', 'get-url', 'origin'])).trim();
        return url || undefined;
    } catch {
        return undefined;
    }
}
