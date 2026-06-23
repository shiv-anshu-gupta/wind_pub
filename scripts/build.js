/**
 * Build script - copies frontend files to dist folder
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

console.log('🔨 Building frontend...');

// Clean dist folder
if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

// Copy files
const filesToCopy = [
    { src: 'index.html', dest: 'index.html' },
    { src: 'style.css', dest: 'style.css' },
    { src: 'js', dest: 'js' },
    { src: 'shared', dest: 'shared' },
    { src: 'assets', dest: 'assets' },
];

for (const file of filesToCopy) {
    const srcPath = join(rootDir, file.src);
    const destPath = join(distDir, file.dest);
    
    if (existsSync(srcPath)) {
        cpSync(srcPath, destPath, { recursive: true });
        console.log(`  ✓ ${file.src}`);
    }
}

console.log('✅ Build complete!');
