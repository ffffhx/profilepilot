"""Weak proposals are view selection, never a relaxed identity threshold."""
import base64
import copy
import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]/"public/vision"
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/(name+".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
worker = load("game_follower")
weak = load("game_follow_weak_search")
cv2.setNumThreads(1)

def encoded(image):
    return base64.b64encode(cv2.imencode(".png", image)[1]).decode()

def fixture():
    rng = np.random.default_rng(8837)
    template = rng.integers(25, 245, (41,41,3), dtype=np.uint8)
    image = np.full((480,640,3), 25, np.uint8)
    portrait = cv2.resize(template, (60,60), interpolation=cv2.INTER_NEAREST)
    image[20:80,470:530] = portrait
    image[84:92,470:530] = (255,160,40)
    ring = dict(hueMin=85,hueMax=130,saturationMin=75,valueMin=180,radiusPixels=26)
    alive = dict(portraitTemplate=encoded(portrait),
        portraitRegion=dict(x=470/640,y=20/480,width=60/640,height=60/480),
        healthBarRegion=dict(x=470/640,y=84/480,width=60/640,height=8/480))
    config = dict(width=640,height=480,map=dict(x=10/640,y=0,width=425/640,height=425/480),
        cameraAssist={},cameraViewportGuard={},targetRing=ring,
        targetWeakSearch=dict(version=1,alive=alive))
    hud = worker.TargetPartial(template,dict(ring=ring,alive=alive),640,480,1.5)
    gate = worker.TargetRing(template,ring)
    search = weak.WeakCameraSearch(config,template,gate.accept,hud.alive)
    return config,image,template,search,hud

def avatar(image,template,x=220,y=200,color=(255,160,40)):
    image[y-20:y+21,x-20:x+21]=template
    cv2.circle(image,(x,y),26,color,2)
    return image

def proposals(search,image,own=True):
    return search.candidates(image[:425,10:435],image,own)

class WeakSearchTests(unittest.TestCase):
    def test_current_proposal_uses_native_origin_without_identity_or_mutation(self):
        _,image,template,search,_=fixture()
        avatar(image,template)
        before=image.copy()
        found=proposals(search,image)
        self.assertEqual(len(found),1)
        self.assertEqual(set(found[0]),{'x','y','score'})
        self.assertEqual((found[0]['x'],found[0]['y']),(220.5,200.5))
        self.assertGreaterEqual(found[0]['score'],.999)
        self.assertTrue(np.array_equal(image,before))
        image[:425,10:435]=25
        self.assertEqual(proposals(search,image),[],"no proposal survives a missing current frame")

    def test_fixed_weak_gate_does_not_change_complete_identity(self):
        _,image,template,search,_=fixture()
        avatar(image,template)
        image[180:190,200:241]=25
        found=proposals(search,image)
        self.assertEqual(len(found),1)
        self.assertGreaterEqual(found[0]['score'],.8)
        self.assertLess(found[0]['score'],.9)
        full=worker.match(image[:425,10:435],template)
        self.assertLess(full['confidence'],.9)
        self.assertAlmostEqual(found[0]['score'],full['confidence'],places=6)
        image[180:221,200:221]=25
        self.assertEqual(proposals(search,image),[],"half face cannot relax the fixed .8 proposal threshold")

    def test_only_first_two_raw_peaks_are_considered_not_two_colour_filtered_winners(self):
        _,image,template,search,_=fixture()
        for x,color in [(80,(0,0,255)),(200,(0,0,255)),(330,(255,160,40))]:
            avatar(image,template,x=x,y=130,color=color)
        self.assertEqual(proposals(search,image),[],"rank3 ally must not replace raw rank1/2 enemies")
        image[:425,10:435]=25
        for x in (80,200,330):avatar(image,template,x=x,y=130)
        found=proposals(search,image)
        self.assertEqual(len(found),2)
        self.assertEqual([(p['x'],p['y']) for p in found],[(80.5,130.5),(200.5,130.5)])

    def test_current_non_camera_self_is_required_before_any_hud_or_matching(self):
        _,image,template,search,_=fixture()
        avatar(image,template)
        with patch.object(search,'alive_check',side_effect=AssertionError('self required')):
            for own in (False,None,1,{},'camera'):
                self.assertEqual(proposals(search,image,own),[])

    def test_postmatch_death_wrong_hud_identity_and_opaque_overlay_reject(self):
        _,image,template,search,hud=fixture()
        avatar(image,template)
        self.assertTrue(hud.alive(image))
        for kind in ('postmatch','gray-death','no-hp','wrong-hud','opaque-overlay'):
            bad=image.copy()
            if kind=='postmatch':bad[:]=100
            elif kind=='gray-death':
                bad[20:80,470:530]=cv2.cvtColor(cv2.cvtColor(bad[20:80,470:530],cv2.COLOR_BGR2GRAY),cv2.COLOR_GRAY2BGR)
            elif kind=='no-hp':bad[84:92,470:530]=0
            elif kind=='wrong-hud':bad[20:80,470:530]=np.flip(bad[20:80,470:530],axis=1)
            else:bad[:100,460:540]=80
            with self.subTest(kind=kind):self.assertEqual(proposals(search,bad),[])

    def test_enemy_team_wrong_avatar_and_terrain_do_not_become_identity(self):
        _,image,template,search,_=fixture()
        avatar(image,template,color=(0,0,255))
        self.assertEqual(proposals(search,image),[])
        image[:425,10:435]=25
        other=np.random.default_rng(771).integers(25,245,(41,41,3),dtype=np.uint8)
        avatar(image,other)
        self.assertEqual(proposals(search,image),[])
        image[:425,10:435]=25
        cv2.rectangle(image,(150,150),(190,190),(255,160,40),2)
        self.assertEqual(proposals(search,image),[])

    def test_full_native_frame_and_its_actual_unmasked_map_are_required(self):
        _,image,template,search,_=fixture()
        avatar(image,template)
        minimap=image[:425,10:435].copy()
        with self.assertRaises(ValueError):search.candidates(minimap,image[:425,:425],True)
        with self.assertRaises(ValueError):search.candidates(minimap.astype(np.float32),image,True)
        with self.assertRaises(ValueError):search.candidates(minimap[:400],image,True)
        minimap[:10]=0
        with self.assertRaises(ValueError):search.candidates(minimap,image,True)

    def test_optin_requires_fixed_version_41px_template_and_all_existing_gates(self):
        config,_,template,search,_=fixture()
        for change in ('missing-optin','version','threshold-knob','cameraAssist','cameraViewportGuard','targetRing'):
            bad=copy.deepcopy(config)
            if change=='missing-optin':bad.pop('targetWeakSearch')
            elif change=='version':bad['targetWeakSearch']['version']=True
            elif change=='threshold-knob':bad['targetWeakSearch']['score']=.6
            else:bad.pop(change)
            with self.subTest(change=change),self.assertRaises(ValueError):
                weak.WeakCameraSearch(bad,template,search.ring_accept,search.alive_check)
        for bad in (template[:39,:39],np.zeros((41,41,3),np.uint8),template.astype(np.float32)):
            with self.assertRaises(ValueError):weak.WeakCameraSearch(config,bad,search.ring_accept,search.alive_check)
        for gates in ((None,search.alive_check),(search.ring_accept,None)):
            with self.assertRaises(ValueError):weak.WeakCameraSearch(config,template,*gates)

    def test_finite_geometry_and_matching_do_not_accept_invalid_values(self):
        config,_,template,search,_=fixture()
        for value in (True,float('nan'),float('inf'),10**10000):
            bad=copy.deepcopy(config);bad['map']['x']=value
            with self.assertRaises(ValueError):weak.WeakCameraSearch(bad,template,search.ring_accept,search.alive_check)
        _,image,_,_,_=fixture()
        with patch.object(cv2,'matchTemplate',return_value=np.full((385,385),float('nan'),np.float32)):
            with patch.object(search,'alive_check',return_value=True):
                self.assertEqual(proposals(search,image),[])

if __name__=='__main__':unittest.main()
