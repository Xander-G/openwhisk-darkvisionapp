/**
 * Copyright 2017 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the “License”);
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an “AS IS” BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Cloudant = require('cloudant');
const async = require('async');

function CloudandStorage(options) {
  const self = this;

  // Cloudant plans have rate limits.
  // The 'retry' plugin catches error 429 from Cloudant and automatically retries
  const cloudant = Cloudant({
    url: options.cloudantUrl,
    plugin: 'retry',
    retryAttempts: 10,
    retryTimeout: 500
  }).db;
  const cloudantNoRetry = Cloudant({
    url: options.cloudantUrl
  }).db;

  let visionDb;
  let uploadDb;
  const fileStore = options.fileStore;

  if (!options.initializeDatabase) {
    visionDb = cloudant.use(options.cloudantDbName);
    uploadDb = cloudantNoRetry.use(options.cloudantDbName);
  } else {
    const prepareDbTasks = [];

    // create the db
    prepareDbTasks.push(
      (callback) => {
        console.log('Creating database...');
        cloudant.create(options.cloudantDbName, (err) => {
          if (err && err.statusCode === 412) {
            console.log('Database already exists');
            callback(null);
          } else if (err) {
            callback(err);
          } else {
            callback(null);
          }
        });
      });

    // use it
    prepareDbTasks.push(
      (callback) => {
        console.log('Setting current database to', options.cloudantDbName);
        visionDb = cloudant.use(options.cloudantDbName);
        uploadDb = cloudantNoRetry.use(options.cloudantDbName);
        callback(null);
      });

    // create design documents
    const designDocuments = require('./cloudant-designs.json');
    designDocuments.docs.forEach((doc) => {
      prepareDbTasks.push((callback) => {
        console.log('Creating', doc._id);
        visionDb.insert(doc, (err) => {
          if (err && err.statusCode === 409) {
            console.log('Design', doc._id, 'already exists');
            callback(null);
          } else if (err) {
            callback(err);
          } else {
            callback(null);
          }
        });
      });
    });

    async.waterfall(prepareDbTasks, (err) => {
      if (err) {
        console.log('Error in database preparation', err);
      }
    });
  }

  // add a new document
  self.insert = function(doc, insertCallback/* err, doc*/) {
    visionDb.insert(doc, (err, body) => {
      insertCallback(err, body);
    });
  };

  // attach a file to a document with a pipe
  self.attach = function(doc, attachmentName, attachmentMimetype, attachCallback/* err, body*/) {
    if (!doc._id) {
      throw new Error('Need a full document here');
    }

    let uploadBucket;

    if (fileStore) {
      // store the file
      console.log('Attaching file to external storage...');
      const filename = `${doc._id}-${attachmentName}`;
      uploadBucket = fileStore.write(filename);

      uploadBucket.on('error', (err) => {
        attachCallback(err);
      });

      uploadBucket.on('success', (file) => {
        console.log(`Upload complete ${file.name} (${file.size} bytes)`);

        if (!doc.attachments) {
          doc.attachments = {};
        }
        // update the document in cloudant with the pointer to the attachment
        doc.attachments[attachmentName] = {
          content_type: attachmentMimetype,
          length: file.size,
          url: `${fileStore.storageUrl()}/${filename}`
        };
        visionDb.insert(doc, (err, body) => {
          attachCallback(err, body);
        });
      });
    } else {
      uploadBucket = uploadDb.attachment.insert(doc._id, attachmentName, null, attachmentMimetype, {
        rev: doc._rev
      }, attachCallback);
    }

    return uploadBucket;
  };

  // attach a file passed as argument to a document
  self.attachFile = function(doc, attachmentName, data,
    attachmentMimetype, attachCallback/* err, body*/) {
    if (fileStore) {
      const stream = require('stream');
      const bufferStream = new stream.PassThrough();
      bufferStream.end(data);
      bufferStream.pipe(self.attach(doc, attachmentName, attachmentMimetype, attachCallback));
    } else {
      visionDb.attachment.insert(doc._id || doc.id, attachmentName, data, attachmentMimetype, {
        rev: doc._rev || doc.rev
      }, attachCallback);
    }
  };

  // return the length of the given attachment
  self.getAttachmentSize = function(doc, attachmentName) {
    if (doc._attachments) {
      return doc._attachments[attachmentName].length;
    } else if (doc.attachments) {
      return doc.attachments[attachmentName].length;
    } else { // eslint-disable-line no-else-return
      return -1;
    }
  };

  // read a file attached to a document or a URL as a string pointing to the content
  self.read = function(docOrId, attachmentName) {
     // this is a real doc and we detect and external storage, stream from the storage
    if (docOrId.attachments) {
      return require('request').get(docOrId.attachments[attachmentName].url);
    } else if (fileStore) {
      return fileStore.read(`${docOrId}-${attachmentName}`);
    } else { // eslint-disable-line no-else-return
      return visionDb.attachment.get(docOrId._id || docOrId, attachmentName);
    }
  };

  // return statistics about processed vs. unprocessed videos
  self.status = function(statusCallback/* err, stats*/) {
    const status = {
      videos: {},
      images: {}
    };

    async.parallel([
      (callback) => {
        visionDb.view('videos', 'all', (err, body) => {
          if (body) {
            status.videos.count = body.total_rows;
            status.videos.all = body.rows;
          }
          callback(null);
        });
      },
      (callback) => {
        visionDb.view('videos', 'to_be_analyzed', (err, body) => {
          if (body) {
            status.videos.to_be_analyzed = body.total_rows;
          }
          callback(null);
        });
      },
      (callback) => {
        visionDb.view('images', 'all', (err, body) => {
          if (body) {
            status.images.count = body.total_rows;
          }
          callback(null);
        });
      },
      (callback) => {
        visionDb.view('images', 'to_be_analyzed', (err, body) => {
          if (body) {
            status.images.to_be_analyzed = body.total_rows;
          }
          callback(null);
        });
      },
      (callback) => {
        visionDb.view('images', 'total_by_video_id', {
          reduce: true,
          group: true
        }, (err, body) => {
          if (body) {
            status.images.by_video_id = body.rows;
          }
          callback(null);
        });
      },
      (callback) => {
        visionDb.view('images', 'processed_by_video_id', {
          reduce: true,
          group: true
        }, (err, body) => {
          if (body) {
            status.images.processed_by_video_id = body.rows;
          }
          callback(null);
        });
      }
    ], (err) => {
      statusCallback(err, status);
    });
  };

  // get all standalone images
  self.images = function(callback/* err, images*/) {
    visionDb.view('images', 'standalone', {
      include_docs: true
    }, (err, body) => {
      if (err) {
        callback(err);
      } else {
        callback(null, body.rows.map(doc => doc.doc));
      }
    });
  };

  // reset one image
  self.imageReset = function(imageId, resetCallback/* err, result*/) {
    async.waterfall([
      (callback) => {
        // get the image
        visionDb.get(imageId, {
          include_docs: true
        }, (err, body) => {
          callback(err, body);
        });
      },
      (image, callback) => {
        console.log('Removing analysis from image...');
        delete image.analysis;
        visionDb.insert(image, (err, body) => {
          callback(err, body);
        });
      }
    ], resetCallback);
  };

  // delete one media
  self.delete = function(mediaId, deleteCallback/* err, result*/) {
    async.waterfall([
      // get the media
      (callback) => {
        visionDb.get(mediaId, {
          include_docs: true
        }, (err, body) => {
          callback(err, body);
        });
      },
      // delete its attachments
      (doc, callback) => {
        console.log('Deleting media...');
        removeFileStoreAttachments(doc);
        visionDb.destroy(doc._id, doc._rev, (err, body) => {
          callback(err, body);
        });
      }
    ], deleteCallback);
  };

  // get all videos
  self.videos = function(videosCallback/* err, videos*/) {
    visionDb.view('videos', 'all', {
      include_docs: true
    }, (err, body) => {
      if (err) {
        videosCallback(err);
      } else {
        videosCallback(null, body.rows.map(doc => doc.doc));
      }
    });
  };

  function removeFileStoreAttachments(doc) {
    if (fileStore && doc.attachments) {
      Object.keys(doc.attachments).forEach((key) => {
        const filename = `${doc._id}-${key}`;
        fileStore.delete(filename, (err) => {
          if (err) {
            console.log('Failed to delete', filename);
          }
        });
      });
    }
  }

  function removeFileStoreAttachment(doc, attachmentName) {
    if (fileStore && doc.attachments && doc.attachments[attachmentName]) {
      const filename = `${doc._id}-${attachmentName}`;
      fileStore.delete(filename, (err) => {
        if (err) {
          console.log('Failed to delete', filename);
        }
      });
    }
  }

  // get one media
  self.get = function(mediaId, callback/* err, media*/) {
    visionDb.get(mediaId, {
      include_docs: true
    }, callback);
  };

  // get all images for a video
  self.videoImages = function(videoId, callback/* err, images*/) {
    visionDb.view('images', 'by_video_id', {
      key: videoId,
      include_docs: true
    }, (err, body) => {
      if (err) {
        callback(err);
      } else {
        callback(null, body.rows.map(doc => doc.doc));
      }
    });
  };

  // reset a video
  self.videoReset = function(videoId, resetCallback/* err, result*/) {
    // remove all analysis for the give video
    async.waterfall([
      // get all images for this video
      (callback) => {
        console.log('Retrieving all images for', videoId);
        visionDb.view('images', 'by_video_id', {
          key: videoId,
          include_docs: true
        }, (err, body) => {
          callback(err, body ? body.rows : null);
        });
      },
      // delete the images
      (images, callback) => {
        const toBeDeleted = {
          docs: images.map(row => ({
            _id: row.doc._id,
            _rev: row.doc._rev,
            _deleted: true
          }))
        };
        console.log('Deleting', toBeDeleted.docs.length, 'images...');

        // drop the attachments
        images.forEach(image => removeFileStoreAttachments(image.doc));

        // and the documents
        if (toBeDeleted.docs.length > 0) {
          visionDb.bulk(toBeDeleted, (err) => {
            callback(err);
          });
        } else {
          callback(null);
        }
      },
      // get the video
      (callback) => {
        console.log('Loading video', videoId);
        visionDb.get(videoId, {
          include_docs: true
        }, (err, body) => {
          callback(err, body);
        });
      },
      // remove the thumbnail
      (video, callback) => {
        if (fileStore) {
          removeFileStoreAttachment(video, 'thumbnail.jpg');
          callback(null);
        } else if (video._attachments && video._attachments['thumbnail.jpg']) {
          console.log('Removing thumbnail...');
          visionDb.attachment.destroy(video._id, 'thumbnail.jpg', {
            rev: video._rev
          }, (err) => {
            callback(err);
          });
        } else {
          callback(null);
        }
      },
      // read the video again (new rev)
      (callback) => {
        console.log('Refreshing video document...');
        visionDb.get(videoId, {
          include_docs: true
        }, (err, body) => {
          callback(err, body);
        });
      },
      // remove its metadata so it gets re-analyzed
      (video, callback) => {
        console.log('Removing metadata...');
        delete video.metadata;
        delete video.frame_count;
        visionDb.insert(video, (err, body) => {
          callback(err, body);
        });
      }
    ], resetCallback);
  };

  // reset the images within a video
  self.videoImagesReset = function(videoId, resetCallback/* err, result*/) {
    async.waterfall([
      // get all images for this video
      (callback) => {
        console.log('Retrieving all images for', videoId);
        visionDb.view('images', 'by_video_id', {
          key: videoId,
          include_docs: true
        }, (err, body) => {
          callback(err, body ? body.rows.map(row => row.doc) : null);
        });
      },
      // remove their analysis and save them
      (images, callback) => {
        images.forEach((image) => {
          delete image.analysis;
        });
        const toBeUpdated = {
          docs: images
        };
        console.log('Updating', toBeUpdated.docs.length, 'images...');
        visionDb.bulk(toBeUpdated, (err, body) => {
          callback(err, body);
        });
      },
    ], resetCallback);
  };

  function hasAttachment(doc, attachmentName) {
    return (doc.attachments && doc.attachments[attachmentName]) ||
      (doc._attachments && doc._attachments[attachmentName]);
  }

  // check if a video or image has already been processed
  self.isReadyToProcess = function(doc) {
    try {
      if (doc.type === 'video') {
        return hasAttachment(doc, 'video.mp4') && !doc.metadata;
      } else if (doc.type === 'image') {
        return hasAttachment(doc, 'image.jpg') && !doc.analysis;
      } else { // eslint-disable-line no-else-return
        return false;
      }
    } catch (error) {
      console.log(error);
      return false;
    }
  };
}

module.exports = function(options) {
  return new CloudandStorage(options);
};
