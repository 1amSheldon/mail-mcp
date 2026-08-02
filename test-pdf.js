import pdf from 'pdf-parse';
import fs from 'fs';

async function test() {
  try {
    console.log('pdf type:', typeof pdf);
    // If it's a function, it should work
  } catch (e) {
    console.error(e);
  }
}
test();
