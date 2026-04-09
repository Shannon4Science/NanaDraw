/**
 * Copyright (c) 2020-2025, JGraph Holdings Ltd
 * Copyright (c) 2020-2025, draw.io AG
 */
const fs = require('fs');
const sharp = require('sharp');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { imageSize } = require('image-size');

const argv = yargs(hideBin(process.argv)).options({
  file: { type: 'string', demandOption: true, describe: 'The path to the .drawio file' },
  percentage: { type: 'number', demandOption: false, describe: 'The percentage to resize the images to' },
  width: { type: 'number', demandOption: false, describe: 'The width to resize the images to' }
}).argv;

const resizeImage = async (base64Image, percentage, minWidth) =>
  {
    console.log(`Resizing image...`);
    const matches = base64Image.match(/^data:image\/(jpeg|png),(.*);$/);
    if (!matches) return null;
  
    const imageBuffer = Buffer.from(matches[2], 'base64');
    const dimensions = imageSize(imageBuffer);
  
    let targetWidth;
  
    if (percentage)
    {
      const calculatedWidth = Math.floor(dimensions.width * (percentage / 100));
      console.log(`Original width: ${dimensions.width}, Percentage resize: ${percentage}%, Calculated width: ${calculatedWidth}`);
  
      // Enforce minimum width if provided
      targetWidth = minWidth ? Math.max(calculatedWidth, minWidth) : calculatedWidth;
    }
    else if (minWidth)
    {
      targetWidth = minWidth;
      console.log(`Using minimum width directly: ${minWidth}`);
    }
    else
    {
      console.log(`No resizing parameters provided`);
      return null;
    }
  
    console.log(`Final target width: ${targetWidth}`);
  
    return sharp(imageBuffer)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .toBuffer()
      .then(resizedBuffer =>
      {
        console.log(`Image resized to width: ${targetWidth}px`);
        return `data:image/${matches[1]},` + resizedBuffer.toString('base64') + ';';
      });
  };

const processDrawioFile = async (filePath, percentage, width) =>
{
  console.log(`Starting processing of ${filePath}`);
  
  if (!(percentage || width))
  {
    console.log(`You must pass in one of percentage or width`);
    return;
  }

  try
  {
    let data = fs.readFileSync(filePath, { encoding: 'utf-8' });
    // Adjust the regex pattern to expect ";" as the closing character of the base64 data
    const base64Pattern = /data:image\/(?:jpeg|png),[^;]+;/g;
    const images = [...data.matchAll(base64Pattern)].map(match => match[0]);

    console.log(`Found ${images.length} images to process.`);

    for (let i = 0; i < images.length; i++)
    {
      console.log(`Processing image ${i + 1} of ${images.length}...`);
      const newBase64 = await resizeImage(images[i], percentage, width);

      if (newBase64)
      {
        data = data.replace(images[i], newBase64);
      }
    }

    fs.writeFileSync(filePath, data, { encoding: 'utf-8' });
    console.log(`All images processed. Updated file saved.`);
  }
  catch (error)
  {
    console.error(`Error processing file: ${error.message}`);
  }
};

processDrawioFile(argv.file, argv.percentage, argv.width);

