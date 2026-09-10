import unittest
from unittest.mock import patch
from wav2vec_aligner.audio import read_pcm_range, validate_metadata


class Response:
    status = 206
    headers = {"Content-Length": "32000", "Content-Range": "bytes 32044-64043/96044"}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return bytes(32000)


class AudioRangeTests(unittest.TestCase):
    def test_nonzero_source_offset(self):
        metadata = {"dataOffset": 44, "dataLength": 96000, "durationUs": 3000000}
        with patch('urllib.request.urlopen', return_value=Response()) as fetch:
            self.assertEqual(len(read_pcm_range('https://example.com/audio', metadata, 1000000, 2000000)), 32000)
            self.assertEqual(fetch.call_args.args[0].headers['Range'], 'bytes=32044-64043')

    def test_refuses_unbounded_or_wrong_ranges(self):
        metadata = {"dataOffset": 44, "dataLength": 96000, "durationUs": 3000000}
        for status, content_range in [(200, 'bytes 32044-64043/96044'), (206, 'bytes 44-32043/96044')]:
            response = Response()
            response.status = status
            response.headers = {**response.headers, 'Content-Range': content_range}
            with patch('urllib.request.urlopen', return_value=response), self.assertRaises(ValueError):
                read_pcm_range('https://example.com/audio', metadata, 1000000, 2000000)

    def test_refuses_invalid_metadata_and_bounds(self):
        with self.assertRaises(ValueError):
            validate_metadata({"dataOffset": 44, "dataLength": 32000, "durationUs": 2000000})
        with self.assertRaises(ValueError):
            read_pcm_range('https://example.com/audio', {"dataOffset": 44, "dataLength": 32000, "durationUs": 1000000}, -1, 1000000)
